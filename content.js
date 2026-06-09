// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  LinkedIn Helper Pro — content script                                    ║
// ║  v2.0.0                                                                  ║
// ║                                                                          ║
// ║  Runs in the LinkedIn page context. Handles:                             ║
// ║   • Voyager API calls (people search, profile lookup, contact email)    ║
// ║   • DOM automation for messaging, connecting                             ║
// ║   • Floating launcher button + iframe popup                              ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const DEBUG = false;
const log   = (...a) => { if (DEBUG) console.log('[LH-Pro]', ...a); };

// ── Generic helpers ──────────────────────────────────────────────────────────

const wait = ms => new Promise(r => setTimeout(r, ms));

// Poll a finder fn until it returns a truthy value or we time out.
// Uses MutationObserver where possible for fewer wasted cycles.
function poll(finder, { attempts = 20, interval = 500, root = document } = {}) {
  return new Promise(resolve => {
    const tryOnce = () => { try { return finder(); } catch { return null; } };
    const first = tryOnce();
    if (first) return resolve(first);

    let attemptsLeft = attempts;
    const observer = new MutationObserver(() => {
      const found = tryOnce();
      if (found) { observer.disconnect(); clearInterval(ticker); resolve(found); }
    });
    observer.observe(root, { childList: true, subtree: true, attributes: true });

    // Fallback ticker — covers cases where the change isn't a DOM mutation
    const ticker = setInterval(() => {
      const found = tryOnce();
      if (found) { observer.disconnect(); clearInterval(ticker); return resolve(found); }
      if (--attemptsLeft <= 0) { observer.disconnect(); clearInterval(ticker); resolve(null); }
    }, interval);
  });
}

// ── CSRF + Voyager helpers ───────────────────────────────────────────────────

function getCsrf() {
  // Cookie may be wrapped in double quotes — strip them.
  const match = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
  return match ? match[1] : '';
}

function toDomain(company) {
  return company.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
}

const ALL_FORMATS = ['first.last', 'flast', 'firstlast', 'first', 'f.last', 'first_last'];

function buildEmail(fmt, f, l, domain) {
  switch (fmt) {
    case 'flast':       return `${f[0]}${l}@${domain}`;
    case 'firstlast':   return `${f}${l}@${domain}`;
    case 'first':       return `${f}@${domain}`;
    case 'f.last':      return `${f[0]}.${l}@${domain}`;
    case 'first_last':  return `${f}_${l}@${domain}`;
    case 'first.last':
    default:            return `${f}.${l}@${domain}`;
  }
}

function buildEmailFormats(firstName, lastName, company, formats = {}) {
  const f = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const l = lastName.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, '');
  const all = { ...DEFAULT_COMPANY_FORMATS, ...formats };
  const companyLower = company.toLowerCase();
  const matchedKey = Object.keys(all).find(k => companyLower.includes(k.toLowerCase()));
  if (matchedKey) {
    const domain = matchedKey + '.com';
    const email  = buildEmail(all[matchedKey], f, l, domain);
    return { primary: email, formats: { [all[matchedKey]]: email } };
  }
  const domain = toDomain(company);
  const out = {};
  ALL_FORMATS.forEach(fmt => { out[fmt] = buildEmail(fmt, f, l, domain); });
  return { primary: out['first.last'], formats: out };
}

function hdrs(csrf) {
  return {
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
    'csrf-token': csrf,
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
  };
}

// Resilient Voyager fetch — handles transient 429/5xx with backoff.
async function voyagerFetch(url, csrf, { retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { headers: hdrs(csrf), credentials: 'include' });
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      if (attempt === retries) throw new Error(`LinkedIn API ${res.status}`);
      await wait(800 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`LinkedIn API ${res.status}`);
    return res.json();
  }
}

async function fetchContactEmail(csrf, slug, profileId) {
  const url = `https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true`
    + `&variables=(memberIdentity:${slug})`
    + `&queryId=voyagerIdentityDashProfiles.c7452e58fa37646d09dae4920fc5b4b9`;
  try {
    const data = await voyagerFetch(url, csrf, { retries: 1 });
    const item = (data.included || []).find(e => e.entityUrn === `urn:li:fsd_profile:${profileId}`);
    return item?.emailAddress?.emailAddress || null;
  } catch { return null; }
}

async function fetchProfileCompany(csrf, slug) {
  const url = `https://www.linkedin.com/voyager/api/identity/dash/profiles`
    + `?q=memberIdentity&memberIdentity=${slug}`
    + `&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93`;
  try {
    const data = await voyagerFetch(url, csrf, { retries: 1 });
    const included = data.included || [];
    // Prefer the current role (no end date)
    for (const item of included) {
      if (item.companyName && !item.dateRange?.end) return item.companyName;
    }
    return (included.find(i => i.companyName))?.companyName || null;
  } catch { return null; }
}

async function fetchPage(csrf, query, start) {
  const keywords  = encodeURIComponent(query);
  const variables = `(start:${start},origin:SWITCH_SEARCH_VERTICAL,query:(keywords:${keywords},`
    + `flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:resultType,value:List(PEOPLE))),`
    + `includeFiltersInResponse:false))`;
  const url = `https://www.linkedin.com/voyager/api/graphql?variables=${variables}`
    + `&queryId=voyagerSearchDashClusters.bb967969ef89137e6dec45d038310505`;

  const data     = await voyagerFetch(url, csrf);
  const included = data.included || [];
  const clusters = data?.data?.data?.searchDashClustersByAll?.elements || [];
  const raw = [];

  for (const cluster of clusters) {
    for (const it of (cluster.items || [])) {
      const entityUrn =
        it?.item?.['*entityResult'] ||
        it?.item?.entityResult?.entityUrn;
      if (!entityUrn) continue;
      const entity = included.find(e => e.entityUrn === entityUrn);
      if (!entity) continue;
      const parts     = (entity.title?.text || '').trim().split(' ');
      const firstName = parts[0] || '';
      const lastName  = parts.slice(1).join(' ') || '';
      const slug      = entity.navigationUrl?.split('/in/')[1]?.split('?')[0];
      const profileId = entityUrn.replace('urn:li:fsd_profile:', '');
      const distance  = entity.entityCustomTrackingInfo?.memberDistance
                       || entity.distance?.value
                       || 'OUT_OF_NETWORK';
      const isConnected = distance === 'DISTANCE_1';
      if (firstName && lastName && slug)
        raw.push({ firstName, lastName, slug, profileId, distance, isConnected });
    }
  }
  return raw;
}

// ── Public search functions ──────────────────────────────────────────────────

async function searchAllPeople(query, maxPages = 5, formats = {}) {
  const csrf = getCsrf();
  if (!csrf) return { success: false, error: 'Not logged into LinkedIn. Refresh the page and try again.' };

  const all = [];
  const MAX_PAGES = Math.min(Math.max(1, maxPages), 15);
  const PAGE_SIZE = 10;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const raw = await fetchPage(csrf, query, page * PAGE_SIZE);

      for (let i = 0; i < raw.length; i += 3) {
        await Promise.all(raw.slice(i, i + 3).map(async p => {
          const realEmail = await fetchContactEmail(csrf, p.slug, p.profileId);
          if (realEmail) {
            all.push({
              firstName: p.firstName, lastName: p.lastName,
              company: '', email: realEmail, emailType: 'real',
              formats: {}, slug: p.slug, profileId: p.profileId,
            });
            return;
          }
          const company = await fetchProfileCompany(csrf, p.slug);
          if (company) {
            const { primary, formats: emailFormats } = buildEmailFormats(p.firstName, p.lastName, company, formats);
            all.push({
              firstName: p.firstName, lastName: p.lastName,
              company, email: primary, emailType: 'guessed',
              formats: emailFormats, slug: p.slug, profileId: p.profileId,
            });
          }
        }));

        chrome.runtime.sendMessage({ action: '_scanProgress', page: page + 1, found: all.length });
        if (i + 3 < raw.length) await wait(500);
      }

      if (raw.length < PAGE_SIZE) break;
      await wait(600);
    }
    return { success: true, profiles: all };
  } catch (e) {
    return { success: false, error: e.message, profiles: all };
  }
}

async function searchPeopleBasic(query, maxPages = 5, excludeCompanies = []) {
  const csrf = getCsrf();
  if (!csrf) return { success: false, error: 'Not logged into LinkedIn. Refresh the page and try again.' };

  const excluded   = excludeCompanies.map(c => c.toLowerCase().trim()).filter(Boolean);
  const isExcluded = company => excluded.some(ex => company.toLowerCase().includes(ex));

  const all = [];
  let filtered = 0;
  const MAX_PAGES = Math.min(Math.max(1, maxPages), 15);
  const PAGE_SIZE = 10;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const raw = await fetchPage(csrf, query, page * PAGE_SIZE);

      for (let i = 0; i < raw.length; i += 3) {
        await Promise.all(raw.slice(i, i + 3).map(async p => {
          const company = await fetchProfileCompany(csrf, p.slug);
          if (company && excluded.length && isExcluded(company)) { filtered++; return; }
          all.push({
            firstName: p.firstName, lastName: p.lastName,
            company: company || '', slug: p.slug, profileId: p.profileId,
            distance: p.distance, isConnected: p.isConnected,
          });
        }));

        chrome.runtime.sendMessage({ action: '_msgProgress', found: all.length, filtered });
        if (i + 3 < raw.length) await wait(500);
      }

      if (raw.length < PAGE_SIZE) break;
      await wait(600);
    }
    return { success: true, people: all, filtered };
  } catch (e) {
    return { success: false, error: e.message, people: all };
  }
}

// ── Direct Voyager messaging APIs (kept for future use) ─────────────────────

function randTrackingId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return String.fromCharCode(...bytes);
}

let _cachedMailboxUrn = null;
async function getMailboxUrn(csrf) {
  if (_cachedMailboxUrn) return _cachedMailboxUrn;
  try {
    const data = await voyagerFetch('https://www.linkedin.com/voyager/api/me', csrf);
    const urns = [
      data.miniProfile?.entityUrn,
      ...(data.included || []).map(e => e.entityUrn),
    ].filter(Boolean);
    for (const urn of urns) {
      if (urn.includes('fs_miniProfile:') || urn.includes('fsd_profile:')) {
        const id = urn.replace(/urn:li:(fs_miniProfile|fsd_profile):/, '');
        _cachedMailboxUrn = `urn:li:fsd_profile:${id}`;
        return _cachedMailboxUrn;
      }
    }
  } catch { /* fall through */ }
  return null;
}

// ── Message bus listener ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  switch (msg.action) {
    case 'searchPeople':
      searchAllPeople(msg.query, msg.maxPages, msg.formats || {})
        .then(reply).catch(e => reply({ success: false, error: e.message }));
      return true;
    case 'searchPeopleBasic':
      searchPeopleBasic(msg.query, msg.maxPages, msg.excludeCompanies || [])
        .then(reply).catch(e => reply({ success: false, error: e.message }));
      return true;
    case 'performDOM_MessageViaInbox':
      performDOM_MessageViaInbox(msg.name, msg.text)
        .then(reply).catch(e => reply({ success: false, error: e.message }));
      return true;
    case 'performDOM_ConnectViaForm':
      performDOM_ConnectViaForm(msg.note)
        .then(reply).catch(e => reply({ success: false, error: e.message }));
      return true;
  }
});

// ── DOM automation: send LinkedIn message via inbox compose ─────────────────

async function performDOM_MessageViaInbox(name, text) {
  log('MessageViaInbox start name=', name);
  const isDirectCompose = window.location.href.includes('profileUrn=')
                       || window.location.href.includes('/thread/new');

  // Direct compose URL — recipient pre-populated; skip name search step
  if (isDirectCompose) {
    const textarea = await poll(() =>
      document.querySelector('div.msg-form__contenteditable') ||
      document.querySelector('div[contenteditable="true"][role="textbox"]') ||
      document.querySelector('div[contenteditable="true"]')
    );
    if (!textarea) return { success: false, error: 'Message textarea not found' };

    textarea.focus();
    document.execCommand('insertText', false, text);
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await wait(600);

    const sendBtn = await poll(findSendButton);
    if (!sendBtn) return { success: false, error: 'Send button not found' };
    sendBtn.click();
    await wait(1000);
    return { success: true };
  }

  // Otherwise — find compose button, type recipient, then message
  const composeBtn = await poll(findComposeButton);
  if (!composeBtn) return { success: false, error: 'Compose button not found' };
  composeBtn.click();

  const searchInput = await poll(() =>
    document.querySelector('input[aria-label*="recipient" i]') ||
    document.querySelector('input[placeholder*="Type a name" i]') ||
    document.querySelector('input[aria-label*="search" i][type="text"]') ||
    document.querySelector('.msg-compose-typeahead__search-input')
  );
  if (!searchInput) return { success: false, error: 'Recipient search input not found' };

  searchInput.focus();
  for (const ch of name) {
    searchInput.value += ch;
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(50);
  }
  await wait(2000);

  const result = await poll(() =>
    document.querySelector('[data-test-msg-compose-typeahead-result]') ||
    document.querySelector('.msg-compose-typeahead__result') ||
    document.querySelector('.artdeco-typeahead__results [role="option"]') ||
    document.querySelector('[role="option"]')
  );
  if (!result) return { success: false, error: `No autocomplete result for "${name}"` };
  result.click();
  await wait(1000);

  const textarea = await poll(() =>
    document.querySelector('div.msg-form__contenteditable') ||
    document.querySelector('div[contenteditable="true"][role="textbox"]') ||
    document.querySelector('div[contenteditable="true"]')
  );
  if (!textarea) return { success: false, error: 'Message textarea not found after selecting recipient' };

  textarea.focus();
  document.execCommand('insertText', false, text);
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await wait(600);

  const sendBtn = await poll(findSendButton);
  if (!sendBtn) return { success: false, error: 'Send button not found' };
  sendBtn.click();
  await wait(1000);
  return { success: true };
}

function findComposeButton() {
  return (
    document.querySelector('button[aria-label="Write a new message"]') ||
    document.querySelector('button[aria-label="Compose new message"]') ||
    document.querySelector('button[aria-label*="ompose" i]') ||
    document.querySelector('[data-test-compose-btn]') ||
    document.querySelector('.msg-overlay-bubble-header__button') ||
    document.querySelector('button.compose-btn') ||
    [...document.querySelectorAll('button, [role="button"]')].find(b => {
      const l = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.innerText || '').trim().toLowerCase();
      return l.includes('compose') || l.includes('new message') || l.includes('write a new')
        || t === 'new message' || t === 'compose';
    })
  );
}

function findSendButton() {
  return (
    document.querySelector('button.msg-form__send-button') ||
    document.querySelector('button[aria-label="Send"]') ||
    [...document.querySelectorAll('button')].find(b =>
      b.getAttribute('aria-label') === 'Send' || (b.innerText || '').trim() === 'Send'
    )
  );
}

// ── DOM automation: send connection request with note ────────────────────────

async function performDOM_ConnectViaForm(note) {
  log('ConnectViaForm URL=', window.location.href);

  // The preload/custom-invite page shows "Add a note to your invitation?" — click it first
  const addNoteBtn = await poll(() =>
    [...document.querySelectorAll('button')].find(b =>
      (b.innerText || '').trim().toLowerCase().includes('add a note')
    )
  );
  if (!addNoteBtn) return { success: false, error: 'Add a note button not found' };
  addNoteBtn.click();
  await wait(800);

  const noteArea = await poll(() =>
    document.querySelector('textarea#custom-message') ||
    document.querySelector('textarea[name="message"]') ||
    document.querySelector('textarea[placeholder*="note" i]') ||
    document.querySelector('textarea[placeholder*="personal" i]') ||
    document.querySelector('textarea')
  );
  if (!noteArea) return { success: false, error: 'Note textarea not found' };

  noteArea.focus();
  noteArea.value = note.substring(0, 300);
  noteArea.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(400);

  const sendBtn = await poll(() =>
    [...document.querySelectorAll('button')].find(b => {
      const t = (b.innerText || '').trim().toLowerCase();
      const l = (b.getAttribute('aria-label') || '').toLowerCase();
      // "Send without a note" must not match — the regex below is strict on words
      return (t === 'send' || t === 'send invitation' || t === 'send now'
        || l === 'send invitation' || l === 'send now');
    }) ||
    [...document.querySelectorAll('button')].find(b => {
      const t = (b.innerText || '').trim().toLowerCase();
      return t.includes('send') && !t.includes('without');
    })
  );
  if (!sendBtn) return { success: false, error: 'Send invitation button not found' };

  sendBtn.click();
  await wait(1000);
  return { success: true };
}

// ── Floating launcher button + iframe popup ──────────────────────────────────

(function createFloatingButton() {
  if (document.getElementById('lh-pro-floating-btn')) return;

  const btn = document.createElement('div');
  btn.id = 'lh-pro-floating-btn';
  btn.title = 'LinkedIn Helper Pro';
  btn.innerHTML = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
      <circle cx="9" cy="7" r="4"></circle>
      <path d="M22 21v-2a4 4 0 0 0-3-3.87"></path>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
    </svg>
  `;

  const panel = document.createElement('div');
  panel.id = 'lh-pro-panel';
  panel.style.display = 'none';

  const panelHeader = document.createElement('div');
  panelHeader.id = 'lh-pro-panel-header';
  panelHeader.innerHTML = `
    <span>LinkedIn Helper Pro</span>
    <div>
      <button id="lh-pro-collapse" title="Hide">—</button>
      <button id="lh-pro-close" title="Close">✕</button>
    </div>
  `;

  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('popup.html');
  iframe.id = 'lh-pro-iframe';

  panel.appendChild(panelHeader);
  panel.appendChild(iframe);

  const style = document.createElement('style');
  style.textContent = `
    #lh-pro-floating-btn {
      position: fixed; bottom: 24px; left: 24px;
      width: 56px; height: 56px; border-radius: 50%;
      background: linear-gradient(135deg, #0073b1 0%, #00568a 100%);
      color: white; cursor: pointer; z-index: 999998;
      box-shadow: 0 6px 18px rgba(0,115,177,0.35);
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.18s ease, box-shadow 0.18s ease;
    }
    #lh-pro-floating-btn:hover {
      transform: translateY(-2px) scale(1.05);
      box-shadow: 0 10px 24px rgba(0,115,177,0.45);
    }
    #lh-pro-panel {
      position: fixed; bottom: 96px; left: 24px;
      background: white; border-radius: 12px;
      box-shadow: 0 16px 48px rgba(0,0,0,0.22);
      overflow: hidden; z-index: 999999;
      border: 1px solid rgba(0,0,0,0.06);
    }
    #lh-pro-panel-header {
      background: linear-gradient(135deg, #0073b1 0%, #00568a 100%);
      color: white; padding: 11px 14px;
      display: flex; align-items: center; justify-content: space-between;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px; font-weight: 700; letter-spacing: 0.2px;
      cursor: move; user-select: none;
    }
    #lh-pro-panel.lh-pro-dragging { transition: none; }
    #lh-pro-panel.lh-pro-dragging #lh-pro-iframe { pointer-events: none; }
    #lh-pro-panel-header div { display: flex; gap: 4px; }
    #lh-pro-panel-header button {
      background: rgba(255,255,255,0.12); border: none; color: white;
      font-size: 14px; cursor: pointer; padding: 0;
      width: 26px; height: 26px; border-radius: 6px;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.15s;
    }
    #lh-pro-panel-header button:hover { background: rgba(255,255,255,0.25); }
    #lh-pro-iframe {
      width: 620px; height: 720px; border: none; display: block;
      background: white;
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(btn);
  document.body.appendChild(panel);

  btn.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
  });
  document.getElementById('lh-pro-close').addEventListener('click', e => {
    e.stopPropagation();
    panel.style.display = 'none';
  });
  document.getElementById('lh-pro-collapse').addEventListener('click', e => {
    e.stopPropagation();
    panel.style.display = 'none';
  });

  // Restore saved position
  try {
    const saved = JSON.parse(localStorage.getItem('lh-pro-panel-pos') || 'null');
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      panel.style.left = saved.left + 'px';
      panel.style.top  = saved.top  + 'px';
      panel.style.bottom = 'auto';
    }
  } catch { /* ignore */ }

  // Drag the panel by its header
  let dragStartX = 0, dragStartY = 0, panelStartLeft = 0, panelStartTop = 0, dragging = false;

  panelHeader.addEventListener('mousedown', e => {
    if (e.target.closest('button')) return; // let buttons handle their own clicks
    const rect = panel.getBoundingClientRect();
    panelStartLeft = rect.left;
    panelStartTop  = rect.top;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragging = true;
    panel.classList.add('lh-pro-dragging');
    // Pin top/left so bottom-anchoring doesn't fight the drag
    panel.style.left   = panelStartLeft + 'px';
    panel.style.top    = panelStartTop  + 'px';
    panel.style.bottom = 'auto';
    panel.style.right  = 'auto';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const maxLeft = Math.max(0, window.innerWidth  - w);
    const maxTop  = Math.max(0, window.innerHeight - h);
    let newLeft = panelStartLeft + (e.clientX - dragStartX);
    let newTop  = panelStartTop  + (e.clientY - dragStartY);
    newLeft = Math.max(0, Math.min(newLeft, maxLeft));
    newTop  = Math.max(0, Math.min(newTop,  maxTop));
    panel.style.left = newLeft + 'px';
    panel.style.top  = newTop  + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('lh-pro-dragging');
    try {
      localStorage.setItem('lh-pro-panel-pos', JSON.stringify({
        left: parseInt(panel.style.left, 10),
        top:  parseInt(panel.style.top,  10),
      }));
    } catch { /* ignore */ }
  });
})();
