// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  LinkedIn Helper Pro — background service worker                         ║
// ║  v2.0.0                                                                  ║
// ║                                                                          ║
// ║  Responsibilities:                                                       ║
// ║   • Gmail OAuth + Gmail API access (read-only, sent-folder duplicate    ║
// ║     prevention)                                                          ║
// ║   • Persistent sent-cache in chrome.storage.local — survives SW restart  ║
// ║   • DOM-driven LinkedIn flows: open profile/compose tab, run script,    ║
// ║     close tab                                                            ║
// ║   • DOM-driven Gmail compose-and-send                                    ║
// ║   • Activity log persistence (last 500 events)                           ║
// ║   • Daily send counters with hourly + daily rate limiting               ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Constants ────────────────────────────────────────────────────────────────
const GMAIL_BASE    = 'https://www.googleapis.com/gmail/v1/users/me';
const CACHE_TTL_MS  = 30 * 60 * 1000;              // 30 minutes
const ACTIVITY_MAX  = 500;                          // rolling log size
const STORAGE_KEYS  = {
  cache:     'gmailCacheV2',
  activity:  'activityLogV2',
  sendStats: 'sendStatsV2',
};

// In-memory shadow of persistent cache for fast O(1) lookups.
// Synced to chrome.storage.local on every write.
let _sentCache         = null;        // Map<emailLower, timestampMs>
let _sentCacheSkipDays = null;        // number — window the cache was built for
let _sentCacheBuiltAt  = 0;           // epoch ms
let _sentCacheBuilding = false;       // mutex
let _cacheHydrated     = false;       // true after first storage load

// ── Storage helpers ──────────────────────────────────────────────────────────

const storageGet = keys => new Promise(res => chrome.storage.local.get(keys, res));
const storageSet = obj  => new Promise(res => chrome.storage.local.set(obj, res));

async function hydrateCacheFromStorage() {
  if (_cacheHydrated) return;
  _cacheHydrated = true;
  try {
    const { [STORAGE_KEYS.cache]: stored } = await storageGet(STORAGE_KEYS.cache);
    if (stored && stored.entries) {
      _sentCache         = new Map(Object.entries(stored.entries));
      _sentCacheSkipDays = stored.skipDays;
      _sentCacheBuiltAt  = stored.builtAt || 0;
    }
  } catch { /* fresh start — leave cache null */ }
}

async function persistCache() {
  if (!_sentCache) return;
  const entries = Object.fromEntries(_sentCache);
  await storageSet({
    [STORAGE_KEYS.cache]: {
      entries,
      skipDays: _sentCacheSkipDays,
      builtAt:  _sentCacheBuiltAt,
    },
  });
}

// ── OAuth ────────────────────────────────────────────────────────────────────

// Cached token from the launchWebAuthFlow fallback (getAuthToken caches its own)
let _webAuthToken = null;
let _webAuthExpiresAt = 0;

function getManifestOAuth() {
  const manifest = chrome.runtime.getManifest();
  const clientId = manifest.oauth2?.client_id || '';
  const scopes = (manifest.oauth2?.scopes || []).join(' ');
  if (clientId.startsWith('YOUR_') || !clientId.includes('.apps.googleusercontent.com')) {
    throw new Error('OAuth client_id is not configured in manifest.json');
  }
  return { clientId, scopes };
}

// Primary: chrome.identity.getAuthToken — needs the OAuth client_id to be a
// "Chrome extension" type whose application ID matches this extension's ID.
function getAuthTokenNative(interactive = false) {
  return new Promise((resolve, reject) => {
    try { getManifestOAuth(); } catch (e) { return reject(e); }
    const timer = setTimeout(
      () => reject(new Error('NATIVE_AUTH_TIMEOUT')),
      8000   // shorter — fall back to launchWebAuthFlow fast
    );
    chrome.identity.getAuthToken({ interactive }, t => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!t) reject(new Error('No auth token returned. User may have dismissed the consent dialog.'));
      else resolve(t);
    });
  });
}

// Fallback: launchWebAuthFlow — works for "Web application" OAuth clients with
// redirect URI https://<extension-id>.chromiumapp.org/. Independent of the
// extension's runtime ID matching the OAuth client's application ID.
function getAuthTokenWebFlow(interactive = false) {
  return new Promise((resolve, reject) => {
    // Reuse a still-valid token (Google access tokens live ~1h; cache 50 min)
    if (_webAuthToken && Date.now() < _webAuthExpiresAt) return resolve(_webAuthToken);

    let clientId, scopes;
    try { ({ clientId, scopes } = getManifestOAuth()); }
    catch (e) { return reject(e); }

    const redirectUri = chrome.identity.getRedirectURL();
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
      + `?client_id=${encodeURIComponent(clientId)}`
      + '&response_type=token'
      + `&redirect_uri=${encodeURIComponent(redirectUri)}`
      + `&scope=${encodeURIComponent(scopes)}`
      + (interactive ? '&prompt=consent' : '');

    const timer = setTimeout(
      () => reject(new Error('WEB_AUTH_TIMEOUT')),
      interactive ? 60000 : 5000  // user interaction can take a while
    );

    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive }, redirectUrl => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!redirectUrl) {
        return reject(new Error('No auth response (consent dismissed or popup blocked).'));
      }
      const frag = redirectUrl.split('#')[1] || '';
      const params = new URLSearchParams(frag);
      const token = params.get('access_token');
      const expiresIn = parseInt(params.get('expires_in') || '3600', 10);
      const err = params.get('error');
      if (err) return reject(new Error(`OAuth error: ${err}`));
      if (!token) return reject(new Error('No access_token in OAuth redirect'));
      _webAuthToken = token;
      _webAuthExpiresAt = Date.now() + (expiresIn - 600) * 1000;
      resolve(token);
    });
  });
}

async function getAuthToken(interactive = false) {
  // Prefer launchWebAuthFlow — it works with Web-application OAuth clients
  // regardless of the extension's runtime ID. chrome.identity.getAuthToken
  // only works for Chrome-Extension type clients and would open a broken
  // consent window if the configured client is Web-app type.
  try {
    return await getAuthTokenWebFlow(interactive);
  } catch (e) {
    try {
      return await getAuthTokenNative(interactive);
    } catch (e2) {
      const detail = [e.message, e2.message].filter(Boolean).join(' | ');
      throw new Error(
        'Gmail authorization failed. '
        + `(${detail}) `
        + 'Verify the OAuth client in Google Cloud Console is "Web application" '
        + 'type with ' + chrome.identity.getRedirectURL()
        + ' listed under Authorized redirect URIs.'
      );
    }
  }
}

function invalidateCachedToken(token) {
  return new Promise(resolve => {
    if (_webAuthToken === token) { _webAuthToken = null; _webAuthExpiresAt = 0; }
    if (!token) return resolve();
    try { chrome.identity.removeCachedAuthToken({ token }, resolve); }
    catch { resolve(); }
  });
}

// Exponential-backoff fetch with 429 / 5xx retry. Caller still owns token refresh.
async function gmailFetch(token, path, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${GMAIL_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      const e = new Error('TOKEN_EXPIRED'); e.expired = true; throw e;
    }
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      if (attempt === retries) throw new Error(`Gmail API ${res.status} after ${retries} retries`);
      const backoff = Math.min(8000, 500 * 2 ** attempt) + Math.random() * 400;
      await delay(backoff);
      continue;
    }
    if (!res.ok) throw new Error(`Gmail API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

async function withToken(fn) {
  let token;
  try { token = await getAuthToken(false); }
  catch { token = await getAuthToken(true); }
  try { return await fn(token); }
  catch (e) {
    if (!e.expired) throw e;
    await invalidateCachedToken(token);
    token = await getAuthToken(true);
    return fn(token);
  }
}

// ── Build / refresh sent-cache ───────────────────────────────────────────────

async function buildSentCache(skipEmailDays) {
  await hydrateCacheFromStorage();
  _sentCache         = new Map();
  _sentCacheSkipDays = skipEmailDays;
  _sentCacheBuilding = true;

  try {
    await withToken(async token => {
      let q = 'in:sent';
      if (skipEmailDays > 0) {
        const since = new Date(Date.now() - skipEmailDays * 86400000);
        q += ` after:${since.toISOString().slice(0, 10).replace(/-/g, '/')}`;
      }

      // Step 1 — paginate IDs
      const ids = [];
      let pageToken;
      do {
        const url = `/messages?q=${encodeURIComponent(q)}&maxResults=500`
          + (pageToken ? `&pageToken=${pageToken}` : '');
        const page = await gmailFetch(token, url);
        (page.messages || []).forEach(m => ids.push(m.id));
        pageToken = page.nextPageToken;
      } while (pageToken);

      if (!ids.length) return;

      // Step 2 — fetch metadata in chunks of 25 (parallel within chunk)
      for (let i = 0; i < ids.length; i += 25) {
        const chunk = ids.slice(i, i + 25);
        const metas = await Promise.all(
          chunk.map(id =>
            gmailFetch(token, `/messages/${id}?format=metadata&metadataHeaders=To&metadataHeaders=Date`)
              .catch(() => null)
          )
        );
        for (const meta of metas) {
          if (!meta?.payload?.headers) continue;
          const toVal   = meta.payload.headers.find(h => h.name === 'To')?.value   || '';
          const dateVal = meta.payload.headers.find(h => h.name === 'Date')?.value || '';
          // Support multiple recipients: extract every <email> or bare address
          const matches = toVal.match(/<[^>]+>|[^\s,;<>()]+@[^\s,;<>()]+/g) || [];
          const ts = dateVal ? Date.parse(dateVal) : 0;
          for (const m of matches) {
            const email = m.replace(/^<|>$/g, '').toLowerCase().trim();
            if (!_sentCache.has(email) || ts > _sentCache.get(email)) _sentCache.set(email, ts);
          }
        }
      }
    });
  } finally {
    _sentCacheBuilding = false;
    _sentCacheBuiltAt  = Date.now();
    await persistCache();
  }
}

async function ensureCache(skipEmailDays) {
  await hydrateCacheFromStorage();
  const age = Date.now() - _sentCacheBuiltAt;
  if (_sentCache !== null && _sentCacheSkipDays === skipEmailDays && age < CACHE_TTL_MS) return;
  await buildSentCache(skipEmailDays);
}

async function checkRecentlySentGmail(toEmail, skipEmailDays) {
  await ensureCache(skipEmailDays);
  const key = toEmail.toLowerCase();
  const ts  = _sentCache.get(key);
  if (ts === undefined) return false;
  if (skipEmailDays === 0) return true;
  const withinWindow = (Date.now() - ts) < skipEmailDays * 86400000;
  if (!withinWindow) {
    _sentCache.delete(key);
    persistCache().catch(() => {});
  }
  return withinWindow;
}

function markSentInCache(toEmail) {
  if (!_sentCache) return;
  _sentCache.set(toEmail.toLowerCase(), Date.now());
  persistCache().catch(() => {});
}

// ── Daily send counters & rate limiter ───────────────────────────────────────

function todayKey() { return new Date().toISOString().slice(0, 10); }

async function getSendStats() {
  const { [STORAGE_KEYS.sendStats]: stats = {} } = await storageGet(STORAGE_KEYS.sendStats);
  return stats;
}

async function recordSend(channel /* 'email' | 'message' | 'connect' */) {
  const stats = await getSendStats();
  const today = todayKey();
  const now   = Date.now();
  if (!stats[today]) stats[today] = { email: 0, message: 0, connect: 0, hourlyBuckets: {} };
  stats[today][channel] = (stats[today][channel] || 0) + 1;

  // Hourly bucket — used by rate limiter
  const hourBucket = Math.floor(now / 3600000); // hours since epoch
  stats[today].hourlyBuckets[hourBucket] = (stats[today].hourlyBuckets[hourBucket] || 0) + 1;

  // Prune to last 30 days
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  for (const k of Object.keys(stats)) if (k < cutoff) delete stats[k];

  await storageSet({ [STORAGE_KEYS.sendStats]: stats });
  return stats[today];
}

async function checkRateLimit({ channel, maxPerHour, maxPerDay }) {
  if (!maxPerHour && !maxPerDay) return { allowed: true };
  const stats     = await getSendStats();
  const today     = stats[todayKey()] || { email: 0, message: 0, connect: 0, hourlyBuckets: {} };
  const totalToday = (today.email || 0) + (today.message || 0) + (today.connect || 0);
  if (maxPerDay && totalToday >= maxPerDay) {
    return { allowed: false, reason: `Daily limit reached (${totalToday}/${maxPerDay})` };
  }
  if (maxPerHour) {
    const hourBucket = Math.floor(Date.now() / 3600000);
    const thisHour   = today.hourlyBuckets?.[hourBucket] || 0;
    if (thisHour >= maxPerHour) {
      return { allowed: false, reason: `Hourly limit reached (${thisHour}/${maxPerHour})` };
    }
  }
  return { allowed: true };
}

// ── Activity log ─────────────────────────────────────────────────────────────

async function appendActivity(entry) {
  const { [STORAGE_KEYS.activity]: log = [] } = await storageGet(STORAGE_KEYS.activity);
  log.unshift({ ts: Date.now(), ...entry });
  if (log.length > ACTIVITY_MAX) log.length = ACTIVITY_MAX;
  await storageSet({ [STORAGE_KEYS.activity]: log });
}

// ── Sent-today (delivered net of bounces) ────────────────────────────────────

async function gmailCount(token, q) {
  let count = 0, pageToken;
  do {
    const url = `/messages?q=${encodeURIComponent(q)}&maxResults=500`
      + (pageToken ? `&pageToken=${pageToken}` : '');
    const page = await gmailFetch(token, url);
    count += (page.messages || []).length;
    pageToken = page.nextPageToken;
  } while (pageToken);
  return count;
}

async function fetchSentTodayCount() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const after = today.toISOString().slice(0, 10).replace(/-/g, '/');
  return withToken(async token => {
    const [sent, bounced] = await Promise.all([
      gmailCount(token, `in:sent after:${after}`),
      gmailCount(
        token,
        `in:inbox after:${after} (from:mailer-daemon OR from:postmaster `
        + `OR subject:"Delivery Status Notification" OR subject:"Mail Delivery Subsystem" `
        + `OR subject:"Undeliverable")`
      ),
    ]);
    return { sent, bounced, net: Math.max(0, sent - bounced) };
  });
}

// ── Message bus ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  switch (msg.action) {

    // ── DOM-driven actions ──────────────────────────────────────────────────
    case 'openAndMessage':
      openAndMessage(msg.slug, msg.text, msg.name, msg.profileId)
        .then(reply).catch(e => reply({ success: false, error: e.message }));
      return true;
    case 'openAndConnect':
      openAndConnect(msg.slug, msg.note)
        .then(reply).catch(e => reply({ success: false, error: e.message }));
      return true;
    case 'openAndEmail':
      openAndEmail(msg).then(reply).catch(e => reply({ success: false, error: e.message }));
      return true;

    // ── Gmail / cache ───────────────────────────────────────────────────────
    case 'checkRecentlySent':
      checkRecentlySentGmail(msg.toEmail, msg.skipEmailDays)
        .then(alreadySent => reply({ success: true, alreadySent }))
        .catch(e => reply({ success: false, error: e.message }));
      return true;
    case 'authorizeGmail':
      getAuthToken(true)
        .then(() => reply({ success: true }))
        .catch(e => reply({ success: false, error: e.message }));
      return true;
    case 'getCacheSize':
      hydrateCacheFromStorage().then(() => {
        let sizeBytes = null;
        if (_sentCache !== null) {
          let bytes = 0;
          for (const [email] of _sentCache) bytes += email.length * 2 + 8;
          sizeBytes = bytes;
        }
        reply({
          success: true,
          cacheSize:    _sentCache?.size ?? null,
          sizeBytes,
          cacheBuiltAt: _sentCacheBuiltAt,
          building:     _sentCacheBuilding,
        });
      });
      return true;
    case 'refreshSentCache':
      _sentCache = null;
      _sentCacheSkipDays = null;
      _sentCacheBuiltAt  = 0;
      ensureCache(msg.skipEmailDays ?? 7)
        .then(() => {
          let bytes = 0;
          for (const [email] of _sentCache) bytes += email.length * 2 + 8;
          reply({
            success: true,
            cacheSize: _sentCache?.size ?? 0,
            sizeBytes: bytes,
            cacheBuiltAt: _sentCacheBuiltAt,
          });
        })
        .catch(e => reply({ success: false, error: e.message }));
      return true;
    case 'fetchSentTodayFromGmail':
      fetchSentTodayCount()
        .then(({ sent, bounced, net }) => reply({ success: true, count: net, sent, bounced }))
        .catch(e => reply({ success: false, error: e.message }));
      return true;

    // ── Stats / activity log ────────────────────────────────────────────────
    case 'getSendStats':
      getSendStats().then(stats => reply({ success: true, stats }));
      return true;
    case 'getActivityLog':
      storageGet(STORAGE_KEYS.activity).then(d =>
        reply({ success: true, log: d[STORAGE_KEYS.activity] || [] })
      );
      return true;
    case 'clearActivityLog':
      storageSet({ [STORAGE_KEYS.activity]: [] }).then(() => reply({ success: true }));
      return true;
    case 'checkRateLimit':
      checkRateLimit(msg).then(reply);
      return true;

    // ── Email discovery ─────────────────────────────────────────────────────
    case 'scrapeLinkedInEmail':
      scrapeLinkedInEmail(msg.slug).then(reply);
      return true;
    case 'lookupApollo':
      lookupApollo(msg).then(reply);
      return true;
  }
});

// ── Email discovery: LinkedIn Contact-Info scrape ───────────────────────────

async function scrapeLinkedInEmail(slug) {
  if (!slug) return { success: false, error: 'no slug' };
  const url = `https://www.linkedin.com/in/${encodeURIComponent(slug)}/overlay/contact-info/`;
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForLoad(tab.id, 15000);
    // Give the overlay JS a moment to populate the email row
    for (let i = 0; i < 12; i++) {
      await delay(700);
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Strategy 1: any mailto: link in the contact-info dialog
            const mailto = document.querySelector('a[href^="mailto:"]');
            if (mailto) {
              const v = mailto.href.replace(/^mailto:/i, '').split('?')[0];
              if (v.includes('@')) return { email: v };
            }
            // Strategy 2: <section> labelled "Email"
            for (const sec of document.querySelectorAll('section, .pv-contact-info__contact-type')) {
              const h = sec.querySelector('h3, header, .pv-contact-info__header');
              if (!h) continue;
              if (!/email/i.test(h.textContent || '')) continue;
              const m = (sec.textContent || '').match(/[\w.+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/);
              if (m) return { email: m[0] };
            }
            // Strategy 3: dialog contents — first email-shaped string
            const dialog = document.querySelector('[role="dialog"]');
            if (dialog) {
              const m = (dialog.textContent || '').match(/[\w.+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/);
              if (m && !/linkedin\.com$/i.test(m[0])) return { email: m[0] };
            }
            // Detect "Login required" interstitial so we don't keep polling
            if (/sign in|join now/i.test(document.body?.innerText || '')) {
              return { gated: true };
            }
            return null;
          },
        });
        if (result?.email) return { success: true, email: result.email };
        if (result?.gated) return { success: false, error: 'Not authenticated to LinkedIn' };
      } catch (e) { /* page might still be loading */ }
    }
    return { success: false, error: 'No email on contact-info page (not visible / not a connection)' };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ── Email discovery: Apollo.io API ───────────────────────────────────────────

async function lookupApollo({ firstName, lastName, company, apiKey }) {
  if (!apiKey) return { success: false, error: 'No Apollo API key configured' };
  try {
    const res = await fetch('https://api.apollo.io/v1/people/match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify({
        first_name: firstName,
        last_name:  lastName,
        organization_name: company,
        reveal_personal_emails: true,
      }),
    });
    if (res.status === 401 || res.status === 403) {
      return { success: false, error: `Apollo auth ${res.status} — check API key` };
    }
    if (res.status === 429) {
      return { success: false, error: 'Apollo rate-limited (429)' };
    }
    if (!res.ok) {
      const t = (await res.text()).slice(0, 200);
      return { success: false, error: `Apollo ${res.status}: ${t}` };
    }
    const data = await res.json();
    const email = data?.person?.email
               || data?.matches?.[0]?.email
               || null;
    if (!email)                                  return { success: false, error: 'Apollo: no match' };
    if (/email_not_unlocked|unlock|locked/i.test(email))
      return { success: false, error: 'Apollo: email masked (free tier — requires credits)' };
    return { success: true, email };
  } catch (e) {
    return { success: false, error: `Apollo fetch: ${e.message}` };
  }
}

// ── DOM-driven flows ─────────────────────────────────────────────────────────

async function openAndEmail({ toEmail, subject, body, person }) {
  const url = `https://mail.google.com/mail/u/0/?view=cm&fs=1`
    + `&to=${encodeURIComponent(toEmail)}`
    + `&su=${encodeURIComponent(subject)}`
    + `&body=${encodeURIComponent(body)}`;
  const tab = await new Promise(resolve => chrome.tabs.create({ url, active: false }, resolve));
  await waitForLoad(tab.id, 30000);
  await delay(2500);  // let Gmail's compose JS hydrate

  // Poll up to ~25 s for the Send button, then click it with a real mouse
  // event sequence (Gmail ignores synthetic .click() in some cases) and
  // wait for the "Message sent" confirmation before closing the tab.
  let clickResult = null;
  const POLL_MAX = 25;
  for (let i = 0; i < POLL_MAX; i++) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const findSend = () => {
            // Most reliable: the toolbar "Send" button has class aoO inside
            // the compose dialog. Filter to visible elements with text "Send".
            const candidates = [
              ...document.querySelectorAll('div[role="button"][aria-label^="Send"]'),
              ...document.querySelectorAll('div[role="button"][data-tooltip^="Send"]'),
              ...document.querySelectorAll('.aoO[role="button"]'),
              ...document.querySelectorAll('div[role="button"]'),
            ];
            for (const el of candidates) {
              if (!el || !el.isConnected) continue;
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              const text  = (el.innerText  || '').trim();
              const label = (el.getAttribute('aria-label') || '').trim();
              const tip   = (el.getAttribute('data-tooltip') || '').trim();
              if (
                /^Send\b/i.test(text)  ||
                /^Send\b/i.test(label) ||
                /^Send\b/i.test(tip)
              ) return el;
            }
            return null;
          };
          const btn = findSend();
          if (!btn) return { found: false };
          // Click via a full mouse-event sequence so Gmail's handlers fire.
          const fire = (type) => btn.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, view: window, button: 0,
          }));
          btn.focus?.();
          fire('mousedown');
          fire('mouseup');
          fire('click');
          return { found: true };
        },
      });
      if (result?.found) { clickResult = result; break; }
    } catch { /* tab might still be loading — keep polling */ }
    await delay(1000);
  }

  if (!clickResult) {
    chrome.tabs.remove(tab.id).catch(() => {});
    await appendActivity({
      channel: 'email',
      status:  'failed',
      target:  person?.name || toEmail,
      company: person?.company || '',
      email:   toEmail,
      subject,
      error:   'Gmail Send button not found',
    });
    return { success: false, error: 'Gmail Send button not found' };
  }

  // Wait for Gmail's "Message sent" toast OR for the compose dialog to
  // disappear. Closing the tab before this fires cancels the send.
  let sentConfirmed = false;
  for (let i = 0; i < 20; i++) {
    await delay(500);
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const toast = [...document.querySelectorAll('span,div')]
            .find(el => /^(Message sent|Sending\.\.\.|Your message has been sent)/i
              .test((el.innerText || '').trim()));
          const stillComposing = !!document.querySelector('div[role="dialog"] div[role="button"][aria-label^="Send"]');
          return {
            sent:      !!toast && /sent/i.test(toast.innerText),
            composing: stillComposing,
          };
        },
      });
      if (result?.sent || !result?.composing) { sentConfirmed = true; break; }
    } catch { break; }
  }

  // Small grace period so Gmail's outbound request actually flushes
  await delay(1500);
  chrome.tabs.remove(tab.id).catch(() => {});

  if (!sentConfirmed) {
    await appendActivity({
      channel: 'email',
      status:  'failed',
      target:  person?.name || toEmail,
      company: person?.company || '',
      email:   toEmail,
      subject,
      error:   'Send clicked but no confirmation observed',
    });
    return { success: false, error: 'Send clicked but no confirmation' };
  }

  markSentInCache(toEmail);
  await recordSend('email');
  await appendActivity({
    channel: 'email',
    status:  'sent',
    target:  person?.name || toEmail,
    company: person?.company || '',
    email:   toEmail,
    subject,
  });
  return { success: true };
}

async function waitForLoad(tabId, timeoutMs = 30000) {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (current?.status === 'complete') return;
  return new Promise(resolve => {
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') { cleanup(); resolve(); }
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
  });
}

async function sendToTab(tabId, message) {
  for (let i = 0; i < 6; i++) {
    try { return await chrome.tabs.sendMessage(tabId, message); }
    catch { await delay(800); }
  }
  return { success: false, error: 'Content script not ready' };
}

async function openAndMessage(slug, text, name, profileId) {
  const cleanId = profileId?.match(/ACoAA[A-Za-z0-9_-]+/)?.[0];
  const url = cleanId
    ? `https://www.linkedin.com/messaging/compose/?`
      + `profileUrn=${encodeURIComponent('urn:li:fsd_profile:' + cleanId)}`
      + `&recipient=${cleanId}&screenContext=NON_SELF_PROFILE_VIEW&interop=msgOverlay`
    : 'https://www.linkedin.com/messaging/thread/new/';
  const tab = await chrome.tabs.create({ url, active: false });
  await waitForLoad(tab.id);
  await delay(1500);

  const result = await sendToTab(tab.id, { action: 'performDOM_MessageViaInbox', name, text });

  await delay(result?.success ? 400 : 6000);
  chrome.tabs.remove(tab.id).catch(() => {});

  if (result?.success) {
    await recordSend('message');
    await appendActivity({ channel: 'message', status: 'sent', target: name, slug, text });
  } else {
    await appendActivity({
      channel: 'message',
      status:  'failed',
      target:  name,
      slug,
      text,
      error:   result?.error || 'unknown',
    });
  }
  return result;
}

async function openAndConnect(slug, note) {
  const tab = await chrome.tabs.create({
    url: `https://www.linkedin.com/preload/custom-invite/?vanityName=${slug}`,
    active: false,
  });
  await waitForLoad(tab.id);
  await delay(1500);

  const result = await sendToTab(tab.id, { action: 'performDOM_ConnectViaForm', note });

  await delay(result?.success ? 400 : 6000);
  chrome.tabs.remove(tab.id).catch(() => {});

  if (result?.success) {
    await recordSend('connect');
    await appendActivity({ channel: 'connect', status: 'sent', target: slug, slug, text: note });
  } else {
    await appendActivity({
      channel: 'connect',
      status:  'failed',
      target:  slug,
      slug,
      text:    note,
      error:   result?.error || 'unknown',
    });
  }
  return result;
}

// Pre-hydrate cache on SW startup so the popup gets fresh data immediately
chrome.runtime.onInstalled.addListener(() => hydrateCacheFromStorage().catch(() => {}));
chrome.runtime.onStartup.addListener(() => hydrateCacheFromStorage().catch(() => {}));
hydrateCacheFromStorage().catch(() => {});
