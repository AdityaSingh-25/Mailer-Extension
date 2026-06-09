// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  LinkedIn Helper Pro — popup.js                                          ║
// ║  v2.0.0                                                                  ║
// ║                                                                          ║
// ║  All UI logic for the popup / iframe. Talks to:                          ║
// ║   • LinkedIn content script (via chrome.tabs.sendMessage)                ║
// ║   • Background service worker (via chrome.runtime.sendMessage)           ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_FLUSH = 10;
const DEFAULT_PAGES = 5;
const DEFAULT_MSG_TEMPLATE = '__default__';
const DEFAULT_EMAIL_TEMPLATE = '__default__';

// ── Small helpers ────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

const storageGet = keys => new Promise(res => chrome.storage.local.get(keys, res));
const storageSet = obj  => new Promise(res => chrome.storage.local.set(obj, res));

function setStatus(msg)    { $('status').textContent = msg; }
function setMsgStatus(msg) { $('msgStatus').textContent = msg; }

// ── Theme management ─────────────────────────────────────────────────────────

async function applyTheme() {
  const { themeMode = 'system' } = await storageGet('themeMode');
  let effective = themeMode;
  if (themeMode === 'system') {
    effective = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', effective);
  $('themeToggle').textContent = effective === 'dark' ? '☀' : '🌙';
  $$('input[name="theme"]').forEach(r => { r.checked = r.value === themeMode; });
}

async function setTheme(mode) {
  await storageSet({ themeMode: mode });
  await applyTheme();
}

async function toggleTheme() {
  const { themeMode = 'system' } = await storageGet('themeMode');
  // Cycle: light → dark → system → light
  const next = themeMode === 'light' ? 'dark' : themeMode === 'dark' ? 'system' : 'light';
  await setTheme(next);
}

// ── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  const {
    flushAt = DEFAULT_FLUSH, maxPages = DEFAULT_PAGES,
    rateLimitEnabled = false, maxPerHour = 15, maxPerDay = 50,
    sendDelay = 1500, emailDelay = 800,
  } = await storageGet([
    'flushAt', 'maxPages',
    'rateLimitEnabled', 'maxPerHour', 'maxPerDay',
    'sendDelay', 'emailDelay',
  ]);
  $('flushAt').value         = flushAt;
  $('maxPages').value        = maxPages;
  $('rateLimitEnabled').checked = rateLimitEnabled;
  $('maxPerHour').value      = maxPerHour;
  $('maxPerDay').value       = maxPerDay;
  $('sendDelay').value       = sendDelay;
  $('emailDelay').value      = emailDelay;
  $('rateLimitFields').style.display = rateLimitEnabled ? 'flex' : 'none';
  return { flushAt, maxPages, rateLimitEnabled, maxPerHour, maxPerDay, sendDelay, emailDelay };
}

async function saveScrapeSettings() {
  const flushAt  = parseInt($('flushAt').value)  || DEFAULT_FLUSH;
  const maxPages = parseInt($('maxPages').value) || DEFAULT_PAGES;
  await storageSet({ flushAt, maxPages });
  return { flushAt, maxPages };
}

async function saveRateLimitSettings() {
  await storageSet({
    rateLimitEnabled: $('rateLimitEnabled').checked,
    maxPerHour:       parseInt($('maxPerHour').value) || 15,
    maxPerDay:        parseInt($('maxPerDay').value)  || 50,
  });
  $('rateLimitFields').style.display = $('rateLimitEnabled').checked ? 'flex' : 'none';
}

async function saveSendBehaviour() {
  await storageSet({
    sendDelay:  parseInt($('sendDelay').value)  || 1500,
    emailDelay: parseInt($('emailDelay').value) || 800,
  });
}

async function loadEmailDiscoverySettings() {
  const {
    useLinkedInScrape = true,
    useApollo = false,
    apolloApiKey = '',
  } = await storageGet(['useLinkedInScrape', 'useApollo', 'apolloApiKey']);
  $('useLinkedInScrape').checked = useLinkedInScrape;
  $('useApollo').checked = useApollo;
  $('apolloApiKey').value = apolloApiKey;
  $('apolloKeyRow').style.display = useApollo ? 'block' : 'none';
}

async function saveEmailDiscoverySettings() {
  await storageSet({
    useLinkedInScrape: $('useLinkedInScrape').checked,
    useApollo:         $('useApollo').checked,
    apolloApiKey:      $('apolloApiKey').value.trim(),
  });
  $('apolloKeyRow').style.display = $('useApollo').checked ? 'block' : 'none';
}

async function testApolloKey() {
  const apiKey = $('apolloApiKey').value.trim();
  const status = $('apolloTestStatus');
  if (!apiKey) {
    status.style.color = 'var(--red)';
    status.textContent = 'Enter an API key first.';
    return;
  }
  status.style.color = 'var(--text-3)';
  status.textContent = 'Testing…';
  const res = await chrome.runtime.sendMessage({
    action: 'lookupApollo',
    firstName: 'Tim', lastName: 'Cook', company: 'Apple', apiKey,
  });
  if (res?.success) {
    status.style.color = 'var(--green)';
    status.textContent = `✓ Working. Sample lookup returned: ${res.email}`;
  } else {
    status.style.color = 'var(--red)';
    status.textContent = `✗ ${res?.error || 'Unknown error'}`;
  }
}

// ── Company format overrides ─────────────────────────────────────────────────
let _userFormats = {};

async function getUserFormats() {
  const { userFormats = {} } = await storageGet('userFormats');
  _userFormats = userFormats;
  return userFormats;
}

function mergedFormats(userFormats) {
  return { ...DEFAULT_COMPANY_FORMATS, ...userFormats };
}

async function renderConfig() {
  const userFormats = await getUserFormats();
  const all = mergedFormats(userFormats);
  $('cfgTbody').innerHTML = Object.entries(all).sort(([a], [b]) => a.localeCompare(b))
    .map(([company, fmt]) => {
      const isUser = company in userFormats;
      return `<tr>
        <td><b>${escapeHtml(company)}</b>.com</td>
        <td><code>${fmt}</code></td>
        <td><span class="badge ${isUser ? 'user' : ''}">${isUser ? 'custom' : 'default'}</span></td>
        <td>${isUser ? `<button class="del-btn" data-c="${escapeHtml(company)}">✕</button>` : ''}</td>
      </tr>`;
    }).join('');

  $$('#cfgTbody .del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { userFormats: uf = {} } = await storageGet('userFormats');
      delete uf[btn.dataset.c];
      await storageSet({ userFormats: uf });
      _userFormats = uf;
      renderConfig();
    });
  });
}

async function addCompanyFormat() {
  const company = $('cfgCompany').value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const fmt = $('cfgFormat').value;
  if (!company) return;
  const { userFormats = {} } = await storageGet('userFormats');
  userFormats[company] = fmt;
  await storageSet({ userFormats });
  _userFormats = userFormats;
  $('cfgCompany').value = '';
  renderConfig();
}

function toggleConfig() {
  const panel = $('configPanel');
  const open = panel.style.display !== 'block';
  panel.style.display = open ? 'block' : 'none';
  $('configToggle').textContent = open ? '✕ Close' : '⚙ Formats';
  if (open) renderConfig();
}

// ── Scraping ─────────────────────────────────────────────────────────────────

async function search() {
  const query = $('q').value.trim();
  if (!query) return;
  const tabs = await chrome.tabs.query({ url: '*://www.linkedin.com/*' });
  const tab = tabs[0];
  if (!tab) return setStatus('Open a LinkedIn page first.');

  const { flushAt, maxPages } = await saveScrapeSettings();
  const userFormats = await getUserFormats();
  const formats = mergedFormats(userFormats);

  setStatus('Fetching page 1…');
  $('search').disabled = true;
  const progressListener = msg => {
    if (msg.action === '_scanProgress') setStatus(`Fetching page ${msg.page}… (${msg.found} found)`);
  };
  chrome.runtime.onMessage.addListener(progressListener);

  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { action: 'searchPeople', query, maxPages, formats });
  } catch (e) {
    res = { success: false, error: 'Cannot reach LinkedIn tab. Reload the LinkedIn page and try again.' };
  } finally {
    chrome.runtime.onMessage.removeListener(progressListener);
    $('search').disabled = false;
  }

  if (!res?.success) return setStatus(res?.error || 'Search failed.');

  const { buffer = [], allProfiles = [] } = await storageGet(['buffer', 'allProfiles']);
  const newBuffer = [...buffer, ...res.profiles];

  if (newBuffer.length >= flushAt) {
    await flushToFile([...allProfiles, ...newBuffer]);
    await storageSet({ buffer: [], allProfiles: [...allProfiles, ...newBuffer] });
    renderTable([]); setCounter(0, flushAt);
    setStatus(`✓ Auto-saved ${allProfiles.length + newBuffer.length} total to linkedin_profiles.csv`);
  } else {
    await storageSet({ buffer: newBuffer });
    renderTable(newBuffer); setCounter(newBuffer.length, flushAt);
    setStatus(`Buffer: ${newBuffer.length}/${flushAt} — Total saved: ${allProfiles.length}`);
  }
}

async function manualExport() {
  const { buffer = [], allProfiles = [] } = await storageGet(['buffer', 'allProfiles']);
  const combined = [...allProfiles, ...buffer];
  if (!combined.length) return;
  await flushToFile(combined);
  await storageSet({ buffer: [], allProfiles: combined });
  const { flushAt } = await loadSettings();
  renderTable([]); setCounter(0, flushAt);
  setStatus(`✓ Saved ${combined.length} profiles to linkedin_profiles.csv`);
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function flushToFile(profiles) {
  const header = 'First Name,Last Name,Company,Email,Email Type,Alt Formats';
  const rows = profiles.map(p => {
    const alts = p.formats ? Object.values(p.formats).filter(e => e !== p.email).join(' | ') : '';
    return [p.firstName, p.lastName, p.company || '', p.email, p.emailType, alts]
      .map(csvEscape).join(',');
  }).join('\n');
  const blob = new Blob([header + '\n' + rows], { type: 'text/csv' });
  return chrome.downloads.download({
    url: URL.createObjectURL(blob),
    filename: 'linkedin_profiles.csv',
    conflictAction: 'overwrite',
    saveAs: false,
  });
}

function renderTable(profiles) {
  $('tbody').innerHTML = profiles.map(p => {
    const alts = p.formats
      ? Object.entries(p.formats).filter(([, v]) => v !== p.email)
        .map(([k, v]) => `<span style="color:var(--text-3)">${k}:</span> ${escapeHtml(v)}`).join('<br>')
      : '';
    const isReal = p.emailType === 'real';
    return `<tr>
      <td>${escapeHtml(p.firstName)}</td>
      <td>${escapeHtml(p.lastName)}</td>
      <td>${escapeHtml(p.company || '—')}</td>
      <td>${escapeHtml(p.email)}</td>
      <td style="color:${isReal ? 'var(--green)' : 'var(--warn)'};font-weight:600">
        ${isReal ? '✓ real' : '~ guessed'}
      </td>
      <td class="alts">${isReal ? '—' : alts || '—'}</td>
    </tr>`;
  }).join('');
  $('export').disabled = profiles.length === 0;
}

function setCounter(n, flushAt) {
  const limit = flushAt || DEFAULT_FLUSH;
  const el = $('counter');
  el.textContent = `${n} / ${limit}`;
  el.style.color = n >= limit ? 'var(--red)' : n > 0 ? 'var(--warn)' : 'var(--text-3)';
}

async function clearStorage() {
  if (!confirm('Clear scraped profiles and the export buffer?')) return;
  await storageSet({ buffer: [], allProfiles: [] });
  const { flushAt } = await loadSettings();
  renderTable([]); setCounter(0, flushAt);
  setStatus('Storage cleared.');
}

// ── Tab switching ────────────────────────────────────────────────────────────

function switchTab(tabName) {
  $$('.tab').forEach(t => t.classList.remove('active'));
  $$('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
  $(`${tabName}Tab`).classList.add('active');

  // Lazy refresh per tab
  if (tabName === 'activity') { renderActivity(); renderStats(); }
  if (tabName === 'messaging') refreshCacheIndicator();
}

// ── Message / email templates ────────────────────────────────────────────────

async function getTemplates(key) {
  const { [key]: t = {} } = await storageGet(key);
  return t;
}

async function saveTemplates(key, templates) {
  await storageSet({ [key]: templates });
}

async function loadCurrentTemplateNames() {
  const {
    msgTemplates    = {},
    emailTemplates  = {},
    currentMsgTemplate   = DEFAULT_MSG_TEMPLATE,
    currentEmailTemplate = DEFAULT_EMAIL_TEMPLATE,
  } = await storageGet([
    'msgTemplates', 'emailTemplates',
    'currentMsgTemplate', 'currentEmailTemplate',
  ]);
  return { msgTemplates, emailTemplates, currentMsgTemplate, currentEmailTemplate };
}

function fillTemplateSelect(selectEl, templates, current) {
  const names = Object.keys(templates).sort();
  // Always show default at top
  selectEl.innerHTML =
    `<option value="${DEFAULT_MSG_TEMPLATE}">Default template</option>`
    + names.filter(n => n !== DEFAULT_MSG_TEMPLATE)
        .map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  selectEl.value = current;
}

async function loadMessageConfig() {
  const { msgTemplates = {}, currentMsgTemplate = DEFAULT_MSG_TEMPLATE } =
    await storageGet(['msgTemplates', 'currentMsgTemplate']);
  fillTemplateSelect($('msgTemplateSelect'), msgTemplates, currentMsgTemplate);
  applyMessageTemplate(msgTemplates[currentMsgTemplate]);

  const { replacements = {}, caseSensitive = false, dryRun = false } =
    await storageGet(['replacements', 'caseSensitive', 'dryRun']);
  $('caseSensitive').checked = caseSensitive;
  $('dryRun').checked = dryRun;
  renderReplacements(replacements);
}

function applyMessageTemplate(tpl) {
  $('messageText').value = (tpl && tpl.text) || '';
}

async function saveMessageConfig() {
  const name = $('msgTemplateSelect').value || DEFAULT_MSG_TEMPLATE;
  const text = $('messageText').value;
  const { msgTemplates = {} } = await storageGet('msgTemplates');
  msgTemplates[name] = { text };
  await storageSet({
    msgTemplates,
    caseSensitive: $('caseSensitive').checked,
    dryRun:        $('dryRun').checked,
  });
  setMsgStatus(`✓ Saved template "${name}".`);
}

// Just persist the flag — don't overwrite template text.
async function saveMessagingFlags() {
  await storageSet({
    caseSensitive: $('caseSensitive').checked,
    dryRun:        $('dryRun').checked,
  });
}

async function saveAsMessageTemplate() {
  const name = $('msgTemplateName').value.trim();
  if (!name) return setMsgStatus('Enter a template name first.');
  const { msgTemplates = {} } = await storageGet('msgTemplates');
  msgTemplates[name] = { text: $('messageText').value };
  await storageSet({ msgTemplates, currentMsgTemplate: name });
  $('msgTemplateName').value = '';
  fillTemplateSelect($('msgTemplateSelect'), msgTemplates, name);
  setMsgStatus(`✓ Created template "${name}".`);
}

async function deleteMessageTemplate() {
  const name = $('msgTemplateSelect').value;
  if (name === DEFAULT_MSG_TEMPLATE) return setMsgStatus('Cannot delete the default template.');
  if (!confirm(`Delete template "${name}"?`)) return;
  const { msgTemplates = {} } = await storageGet('msgTemplates');
  delete msgTemplates[name];
  await storageSet({ msgTemplates, currentMsgTemplate: DEFAULT_MSG_TEMPLATE });
  fillTemplateSelect($('msgTemplateSelect'), msgTemplates, DEFAULT_MSG_TEMPLATE);
  applyMessageTemplate(msgTemplates[DEFAULT_MSG_TEMPLATE]);
  setMsgStatus(`✓ Deleted template "${name}".`);
}

async function onMsgTemplateChange() {
  const name = $('msgTemplateSelect').value;
  const { msgTemplates = {} } = await storageGet('msgTemplates');
  applyMessageTemplate(msgTemplates[name]);
  await storageSet({ currentMsgTemplate: name });
}

function renderReplacements(replacements) {
  const attrLabels = {
    firstName: 'First Name', lastName: 'Last Name',
    fullName:  'Full Name',  company:  'Company Name',
  };
  const rowsHtml = Object.entries(replacements).map(([keyword, attr]) =>
    `<tr>
      <td><b>{${escapeHtml(keyword)}}</b></td>
      <td>${attrLabels[attr] || attr}</td>
      <td><button class="del-btn" data-key="${escapeHtml(keyword)}">✕</button></td>
    </tr>`).join('');
  $$('.replacement-tbody').forEach(tbody => { tbody.innerHTML = rowsHtml; });

  $$('.replacement-tbody .del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { replacements: reps = {} } = await storageGet('replacements');
      delete reps[btn.dataset.key];
      await storageSet({ replacements: reps });
      renderReplacements(reps);
    });
  });
}

async function addReplacementFrom(inputId, attrSelectId) {
  // Strip wrapping braces/brackets/spaces so "{name}", "[name]", "{{name}}"
  // all save as plain "name" — keyword goes in the table, {name} goes in body.
  const keyword = $(inputId).value
    .trim()
    .replace(/^[\{\[\(\s]+|[\}\]\)\s]+$/g, '')
    .toLowerCase();
  const attribute = $(attrSelectId).value;
  if (!keyword) return;
  const { replacements = {} } = await storageGet('replacements');
  replacements[keyword] = attribute;
  await storageSet({ replacements });
  $(inputId).value = '';
  renderReplacements(replacements);
}

const addReplacement      = () => addReplacementFrom('replaceKeyword',      'replaceAttribute');
const addReplacementEmail = () => addReplacementFrom('replaceKeywordEmail', 'replaceAttributeEmail');

// ── Email config ─────────────────────────────────────────────────────────────

async function loadEmailConfig() {
  const { emailTemplates = {}, currentEmailTemplate = DEFAULT_EMAIL_TEMPLATE } =
    await storageGet(['emailTemplates', 'currentEmailTemplate']);
  fillTemplateSelect($('emailTemplateSelect'), emailTemplates, currentEmailTemplate);
  applyEmailTemplate(emailTemplates[currentEmailTemplate]);

  const { skipRecentEmails = false, skipEmailDays = 7 } =
    await storageGet(['skipRecentEmails', 'skipEmailDays']);
  $('skipRecentEmails').checked = skipRecentEmails;
  $('foreverChk').checked       = skipEmailDays === 0;
  $('skipEmailDays').value      = skipEmailDays > 0 ? skipEmailDays : 7;
  $('skipEmailDays').disabled   = skipEmailDays === 0;
  $('skipDaysRow').style.display = skipRecentEmails ? 'flex' : 'none';

  refreshCacheIndicator();
}

function applyEmailTemplate(tpl) {
  $('emailSubject').value = (tpl && tpl.subject) || '';
  $('emailBody').value    = (tpl && tpl.body)    || '';
}

async function saveEmailConfig() {
  const name = $('emailTemplateSelect').value || DEFAULT_EMAIL_TEMPLATE;
  const { emailTemplates = {} } = await storageGet('emailTemplates');
  emailTemplates[name] = {
    subject: $('emailSubject').value,
    body:    $('emailBody').value,
  };
  const forever = $('foreverChk').checked;
  await storageSet({
    emailTemplates,
    skipRecentEmails: $('skipRecentEmails').checked,
    skipEmailDays:    forever ? 0 : (parseInt($('skipEmailDays').value) || 7),
  });
  setMsgStatus(`✓ Saved email template "${name}".`);
}

async function saveAsEmailTemplate() {
  const name = $('emailTemplateName').value.trim();
  if (!name) return setMsgStatus('Enter a template name first.');
  const { emailTemplates = {} } = await storageGet('emailTemplates');
  emailTemplates[name] = {
    subject: $('emailSubject').value,
    body:    $('emailBody').value,
  };
  await storageSet({ emailTemplates, currentEmailTemplate: name });
  $('emailTemplateName').value = '';
  fillTemplateSelect($('emailTemplateSelect'), emailTemplates, name);
  setMsgStatus(`✓ Created email template "${name}".`);
}

async function deleteEmailTemplate() {
  const name = $('emailTemplateSelect').value;
  if (name === DEFAULT_EMAIL_TEMPLATE) return setMsgStatus('Cannot delete the default template.');
  if (!confirm(`Delete email template "${name}"?`)) return;
  const { emailTemplates = {} } = await storageGet('emailTemplates');
  delete emailTemplates[name];
  await storageSet({ emailTemplates, currentEmailTemplate: DEFAULT_EMAIL_TEMPLATE });
  fillTemplateSelect($('emailTemplateSelect'), emailTemplates, DEFAULT_EMAIL_TEMPLATE);
  applyEmailTemplate(emailTemplates[DEFAULT_EMAIL_TEMPLATE]);
  setMsgStatus(`✓ Deleted email template "${name}".`);
}

async function onEmailTemplateChange() {
  const name = $('emailTemplateSelect').value;
  const { emailTemplates = {} } = await storageGet('emailTemplates');
  applyEmailTemplate(emailTemplates[name]);
  await storageSet({ currentEmailTemplate: name });
}

// ── Email building (shared with content.js logic) ────────────────────────────

// Legal/structural suffixes that aren't part of the real email domain.
// Matched as whole words and stripped before domain inference.
const COMPANY_SUFFIX_RE = new RegExp(
  '\\b(inc|incorporated|corp|corporation|company|co|ltd|limited|llc|llp|lp|plc|'
  + 'gmbh|ag|sa|spa|srl|bv|nv|oy|as|aps|kg|kk|'
  + 'pvt|private|pte|pty|sdn|bhd|'
  + 'group|holdings|enterprises|industries|international|intl|'
  + 'services|solutions|systems|consulting|'
  + 'global|worldwide|holding|holdings|the)\\b',
  'gi'
);

function normalizeCompany(company) {
  return (company || '')
    .replace(/[.,&'’]+/g, ' ')      // punctuation → space (keep hyphens)
    .replace(COMPANY_SUFFIX_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toDomain(company) {
  // Keep hyphens (coca-cola.com), drop everything else non-alphanumeric.
  const stripped = normalizeCompany(company).toLowerCase().replace(/[^a-z0-9-]/g, '');
  return (stripped || 'example') + '.com';
}

function buildEmailAddr(fmt, f, l, domain) {
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

// Find the best company-format key for a company name.
//  - Prefers user-defined overrides over defaults.
//  - For short keys (<4 chars) requires a whole-word match — stops "x", "hp",
//    "gm", "pg" from accidentally hitting things like "Maxar", "HPE", "GM Cruise",
//    "Page Inc."
//  - For longer keys uses substring match against the concatenated company
//    so multi-word keys like "bankofamerica" still hit "Bank of America Corp".
//  - Among multiple matches, picks the longest (most specific) key.
function findCompanyKey(company, lookup) {
  const cleaned   = normalizeCompany(company).toLowerCase();
  const wordSet   = new Set(cleaned.split(/[^a-z0-9]+/).filter(Boolean));
  const concatKey = cleaned.replace(/[^a-z0-9]/g, '');

  const matches = [];
  for (const k of Object.keys(lookup)) {
    const kl = k.toLowerCase();
    if (kl.length < 4 ? wordSet.has(kl) : concatKey.includes(kl)) matches.push(kl);
  }
  matches.sort((a, b) => b.length - a.length);
  return matches[0] || null;
}

function generateEmail(person) {
  if (person.email) return person.email; // CSV import or manual override
  const f = (person.firstName || '').toLowerCase().replace(/[^a-z]/g, '');
  const l = (person.lastName  || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!f || !l || !person.company) return '';

  // User overrides take priority. Fall back to the bundled defaults.
  const userKey    = findCompanyKey(person.company, _userFormats);
  const defaultKey = userKey ? null : findCompanyKey(person.company, DEFAULT_COMPANY_FORMATS);
  const matchedKey = userKey || defaultKey;

  const domain = matchedKey ? matchedKey + '.com' : toDomain(person.company);
  const fmt = matchedKey
    ? (userKey ? _userFormats[userKey] : DEFAULT_COMPANY_FORMATS[defaultKey])
    : 'first.last';
  return buildEmailAddr(fmt, f, l, domain);
}

// ── Outreach search & people list ────────────────────────────────────────────

let allPeople = [];
let currentPage = 0;

function getPeoplePerPage() { return parseInt($('msgPerPage').value) || 10; }

// Exclude list
async function loadExcludeInput() {
  const { excludeRaw = '' } = await storageGet('excludeRaw');
  $('excludeInput').value = excludeRaw;
  updateExcludeToggle();
}
function getExcludeList() {
  return $('excludeInput').value
    .split(/[,\n]/).map(s => s.trim().toLowerCase()).filter(Boolean);
}
function saveExcludeInput() {
  storageSet({ excludeRaw: $('excludeInput').value.trim() });
}
function updateExcludeToggle() {
  const count = getExcludeList().length;
  const btn = $('excludeToggle');
  btn.textContent = count ? `🚫 Exclude (${count})` : '🚫 Exclude';
  btn.classList.toggle('has-filters', count > 0);
}

async function searchPeopleForMessaging() {
  const query = $('msgQuery').value.trim();
  if (!query) return;
  const tabs = await chrome.tabs.query({ url: '*://www.linkedin.com/*', currentWindow: true });
  const tab = tabs.find(t => t.active) || tabs[0];
  if (!tab) return setMsgStatus('Open a LinkedIn page first.');

  const maxPages = parseInt($('msgMaxPages').value) || 5;
  const excludeCompanies = getExcludeList();
  saveExcludeInput();

  setMsgStatus('Fetching page 1…');
  $('msgSearch').disabled = true;

  const progressListener = msg => {
    if (msg.action === '_msgProgress') {
      const filteredNote = msg.filtered ? ` · ${msg.filtered} excluded` : '';
      setMsgStatus(`Searching… (${msg.found} found${filteredNote})`);
    }
  };
  chrome.runtime.onMessage.addListener(progressListener);

  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, {
      action: 'searchPeopleBasic', query, maxPages, excludeCompanies,
    });
  } catch {
    res = { success: false, error: 'Cannot reach LinkedIn tab. Reload the LinkedIn page.' };
  } finally {
    chrome.runtime.onMessage.removeListener(progressListener);
    $('msgSearch').disabled = false;
  }

  if (!res?.success) return setMsgStatus(res?.error || 'Search failed.');

  allPeople = res.people || [];
  clearSavedSelections();
  currentPage = 0;
  const filteredNote = res.filtered ? ` · ${res.filtered} excluded` : '';
  if (allPeople.length === 0) {
    setMsgStatus(`No people found${filteredNote}.`);
    $('peopleListContainer').style.display = 'none';
  } else {
    $('peopleListContainer').style.display = 'block';
    renderPeoplePage();
    setMsgStatus(`Found ${allPeople.length} people${filteredNote}.`);
  }
}

function getFilteredPeople() {
  const filter = $('connFilter')?.value || 'all';
  if (filter === 'connected')    return allPeople.filter(p => p.isConnected);
  if (filter === 'notconnected') return allPeople.filter(p => !p.isConnected);
  return allPeople;
}

function renderPeoplePage() {
  const perPage = getPeoplePerPage();
  const filtered = getFilteredPeople();
  const start = currentPage * perPage;
  const pagePeople = filtered.slice(start, start + perPage);
  const totalPages = Math.ceil(filtered.length / perPage);

  $('peopleList').innerHTML = pagePeople.map(person => {
    const realIdx = allPeople.indexOf(person);
    const badge = person.isConnected
      ? '<span class="connection-badge connected">Connected</span>'
      : '<span class="connection-badge not-connected">Not Connected</span>';
    const guessedEmail = generateEmail(person);
    return `
    <div class="person-item">
      <div class="person-info">
        <div class="person-name">${escapeHtml(person.firstName)} ${escapeHtml(person.lastName)} ${badge}</div>
        <div class="person-company">${escapeHtml(person.company || '—')}</div>
        ${guessedEmail ? `<div class="person-email-gen">${escapeHtml(guessedEmail)}</div>` : ''}
      </div>
      <div class="person-actions">
        <button class="preview-btn btn-sm" data-idx="${realIdx}" title="Preview message">👁</button>
        <button class="msg-btn btn-sm" data-idx="${realIdx}" title="Send LinkedIn message">💬</button>
        <button class="email-btn btn-sm" data-idx="${realIdx}" title="Send email">✉</button>
        ${person.company ? `<button class="block-btn btn-sm excl-btn" data-idx="${realIdx}" title="Exclude ${escapeHtml(person.company)}">🚫</button>` : ''}
      </div>
    </div>`;
  }).join('');

  $('peopleCount').textContent = `${filtered.length} people (${allPeople.length} total)`;
  $('pageInfo').textContent = `Page ${currentPage + 1} of ${Math.max(1, totalPages)}`;
  $('prevPage').disabled = currentPage === 0;
  $('nextPage').disabled = currentPage >= totalPages - 1;

  $$('.preview-btn').forEach(b =>
    b.addEventListener('click', () => showMessagePreview(allPeople[parseInt(b.dataset.idx)])));
  $$('.msg-btn').forEach(b =>
    b.addEventListener('click', () => handleMessagePerson(allPeople[parseInt(b.dataset.idx)], b)));
  $$('.email-btn').forEach(b =>
    b.addEventListener('click', () => handleEmailPerson(allPeople[parseInt(b.dataset.idx)], b)));
  $$('.excl-btn').forEach(b =>
    b.addEventListener('click', () => {
      addToExclude(allPeople[parseInt(b.dataset.idx)].company);
      renderPeoplePage();
    }));
}

// Built-in placeholder aliases — work without any keyword-table configuration.
// Keys are lowercased; matching is always case-insensitive.
const BUILTIN_PLACEHOLDERS = {
  firstname: 'firstName', first: 'firstName', name: 'firstName',
  lastname:  'lastName',  last:  'lastName',
  fullname:  'fullName',  full:  'fullName',
  company:   'company',   org:   'company',   employer: 'company',
};

async function transformMessage(person, template, replacements) {
  const { caseSensitive = false } = await storageGet('caseSensitive');
  let message = template || '';
  const attrMap = {
    firstName: person.firstName || '',
    lastName:  person.lastName  || '',
    fullName:  `${person.firstName || ''} ${person.lastName || ''}`.trim(),
    company:   person.company    || 'your company',
  };

  // 1) User-defined keyword mappings (take priority — can override built-ins)
  for (const [keyword, attribute] of Object.entries(replacements)) {
    const flags = caseSensitive ? 'g' : 'gi';
    const safeKw = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\{\\s*${safeKw}\\s*\\}`, flags);
    message = message.replace(regex, attrMap[attribute] ?? '');
  }

  // 2) Built-in placeholders ({firstName}, {name}, {company}, …) — only fire
  //    if the user didn't already replace them above.
  for (const [keyword, attribute] of Object.entries(BUILTIN_PLACEHOLDERS)) {
    const regex = new RegExp(`\\{\\s*${keyword}\\s*\\}`, 'gi');
    message = message.replace(regex, attrMap[attribute] ?? '');
  }

  return message;
}

async function showMessagePreview(person) {
  const { msgTemplates = {}, currentMsgTemplate = DEFAULT_MSG_TEMPLATE, replacements = {} } =
    await storageGet(['msgTemplates', 'currentMsgTemplate', 'replacements']);
  const tpl = msgTemplates[currentMsgTemplate];
  if (!tpl || !tpl.text) {
    alert('Configure a message template first.');
    return;
  }
  const transformed = await transformMessage(person, tpl.text, replacements);
  const conn = person.isConnected ? '✓ Connected' : '✗ Not Connected';
  alert(`Preview — ${person.firstName} ${person.lastName}\n${conn}\nCompany: ${person.company || '—'}\n\n———————\n${transformed}`);
}

async function getLinkedInTab() {
  const tabs = await chrome.tabs.query({ url: '*://www.linkedin.com/*' });
  return tabs[0] || null;
}

async function dispatchMessage(person) {
  const { msgTemplates = {}, currentMsgTemplate = DEFAULT_MSG_TEMPLATE, replacements = {}, dryRun = false } =
    await storageGet(['msgTemplates', 'currentMsgTemplate', 'replacements', 'dryRun']);
  const tpl = msgTemplates[currentMsgTemplate];
  if (!tpl || !tpl.text) { setMsgStatus('Set a message template first.'); return { success: false }; }

  const text = await transformMessage(person, tpl.text, replacements);
  if (dryRun) return { success: true, dryRun: true, text };

  const tab = await getLinkedInTab();
  if (!tab) { setMsgStatus('Open a LinkedIn page first.'); return { success: false }; }

  const filter = $('connFilter')?.value || 'all';
  if (filter === 'notconnected' && person.isConnected)
    return { success: false, error: 'Filter set to non-connections only.' };
  if (filter === 'connected' && !person.isConnected)
    return { success: false, error: 'Filter set to connections only.' };

  if (person.isConnected) {
    return chrome.runtime.sendMessage({
      action: 'openAndMessage',
      slug: person.slug, text,
      name: `${person.firstName} ${person.lastName}`,
      profileId: person.profileId,
    });
  }
  return chrome.runtime.sendMessage({
    action: 'openAndConnect', slug: person.slug, note: text,
  });
}

async function sendEmailToPerson(person) {
  const { emailTemplates = {}, currentEmailTemplate = DEFAULT_EMAIL_TEMPLATE, replacements = {}, dryRun = false } =
    await storageGet(['emailTemplates', 'currentEmailTemplate', 'replacements', 'dryRun']);
  const tpl = emailTemplates[currentEmailTemplate] || {};
  const toEmail = generateEmail(person);
  if (!toEmail) return { success: false, error: `Cannot generate email for ${person.firstName}` };

  const emailDomain = toEmail.split('@')[1] || '';
  const list = getExcludeList();
  const blockedByCompany = list.length && person.company && list.some(ex => person.company.toLowerCase().includes(ex));
  const blockedByDomain  = list.length && list.some(ex => emailDomain.toLowerCase().includes(ex));
  if (blockedByCompany || blockedByDomain) {
    return { success: false, skipped: true, error: `Skipped — ${blockedByCompany ? person.company : emailDomain} is excluded` };
  }

  const skipReason = await checkBeforeSend(toEmail);
  if (skipReason) return { success: false, skipped: true, error: `Skipped — ${skipReason}` };

  const subject = await transformMessage(person, tpl.subject || '', replacements);
  const body    = await transformMessage(person, tpl.body    || '', replacements);

  if (dryRun) return { success: true, dryRun: true, toEmail, subject, body };

  return chrome.runtime.sendMessage({
    action: 'openAndEmail',
    toEmail, subject, body,
    person: { name: `${person.firstName} ${person.lastName}`, company: person.company },
  });
}

async function checkBeforeSend(toEmail) {
  const { skipRecentEmails = false, skipEmailDays = 7 } =
    await storageGet(['skipRecentEmails', 'skipEmailDays']);
  if (!skipRecentEmails || !toEmail) return null;
  try {
    // Bound the wait so a broken Gmail auth never freezes the send loop.
    const res = await Promise.race([
      chrome.runtime.sendMessage({ action: 'checkRecentlySent', toEmail, skipEmailDays }),
      new Promise(resolve => setTimeout(() => resolve({ success: false, timeout: true }), 6000)),
    ]);
    if (!res?.success || !res.alreadySent) return null;
    return skipEmailDays === 0
      ? 'previously contacted (forever)'
      : `contacted within last ${skipEmailDays} day${skipEmailDays === 1 ? '' : 's'}`;
  } catch { return null; }
}

async function checkRateLimitBeforeSend(channel) {
  const { rateLimitEnabled = false, maxPerHour = 0, maxPerDay = 0 } =
    await storageGet(['rateLimitEnabled', 'maxPerHour', 'maxPerDay']);
  if (!rateLimitEnabled) return { allowed: true };
  return chrome.runtime.sendMessage({
    action: 'checkRateLimit',
    channel,
    maxPerHour: parseInt(maxPerHour) || 0,
    maxPerDay:  parseInt(maxPerDay)  || 0,
  });
}

// ── Exclude / preview helpers ────────────────────────────────────────────────

function addToExclude(company) {
  if (!company) return;
  const name = company.toLowerCase().trim();
  const input = $('excludeInput');
  const already = getExcludeList();
  if (already.some(ex => name.includes(ex) || ex.includes(name))) {
    setMsgStatus(`"${company}" already excluded.`);
    return;
  }
  input.value = input.value.trim() ? input.value.trim() + ', ' + name : name;
  saveExcludeInput();
  updateExcludeToggle();
  setMsgStatus(`✓ "${company}" added to exclude list.`);
}

function showSendPreview({ title, meta, body, company, onConfirm }) {
  $('previewTitle').textContent = title;
  $('previewMeta').innerHTML = meta;
  $('previewBody').textContent = body;
  $('sendPreview').classList.add('show');

  const confirm = $('previewConfirm'), cancel = $('previewCancel'), excludeBtn = $('previewExclude');
  const close = () => $('sendPreview').classList.remove('show');

  excludeBtn.style.display = company ? 'inline-flex' : 'none';
  excludeBtn.onclick = () => { addToExclude(company); close(); };
  confirm.onclick = () => { close(); onConfirm(); };
  cancel.onclick  = close;
}

// ── Single-send handlers ─────────────────────────────────────────────────────

let _sending = false;

async function handleMessagePerson(person, btn) {
  if (_sending) return;

  const rl = await checkRateLimitBeforeSend(person.isConnected ? 'message' : 'connect');
  if (!rl.allowed) return setMsgStatus(`⏸ ${rl.reason}. Try again later.`);

  const { msgTemplates = {}, currentMsgTemplate = DEFAULT_MSG_TEMPLATE, replacements = {}, dryRun = false } =
    await storageGet(['msgTemplates', 'currentMsgTemplate', 'replacements', 'dryRun']);
  const tpl = msgTemplates[currentMsgTemplate];
  const replaced = tpl?.text ? await transformMessage(person, tpl.text, replacements) : '';
  const type = person.isConnected ? 'Direct Message' : 'Connection Request';

  showSendPreview({
    title: `${type} Preview${dryRun ? ' · DRY RUN' : ''}`,
    meta: `<b>To:</b> ${escapeHtml(person.firstName + ' ' + person.lastName)} · `
      + `<b>${person.isConnected ? '✓ Connected' : '○ Not Connected'}</b> · ${escapeHtml(person.company || '')}`,
    body: replaced || '(no message template set)',
    company: person.company || '',
    onConfirm: async () => {
      _sending = true;
      if (btn) btn.disabled = true;
      setMsgStatus(`${dryRun ? 'Simulating' : 'Sending'} to ${person.firstName}…`);
      const res = await dispatchMessage(person);
      if (res?.success) setMsgStatus(`✓ ${dryRun ? '[dry run] ' : ''}${type} ${dryRun ? 'would be sent' : 'sent'} to ${person.firstName}`);
      else setMsgStatus(`✗ Failed: ${res?.error || 'unknown error'}`);
      if (btn) btn.disabled = false;
      _sending = false;
    },
  });
}

async function handleEmailPerson(person, btn) {
  if (_sending) return;
  const rl = await checkRateLimitBeforeSend('email');
  if (!rl.allowed) return setMsgStatus(`⏸ ${rl.reason}. Try again later.`);

  const toEmail = generateEmail(person);
  if (toEmail) {
    setMsgStatus(`Checking ${person.firstName}…`);
    const skipReason = await checkBeforeSend(toEmail);
    if (skipReason) return setMsgStatus(`⏭ Skipped ${person.firstName} (${toEmail}) — ${skipReason}`);
  }

  const { emailTemplates = {}, currentEmailTemplate = DEFAULT_EMAIL_TEMPLATE, replacements = {}, dryRun = false } =
    await storageGet(['emailTemplates', 'currentEmailTemplate', 'replacements', 'dryRun']);
  const tpl = emailTemplates[currentEmailTemplate] || {};
  const subject = await transformMessage(person, tpl.subject || '', replacements);
  const body    = await transformMessage(person, tpl.body    || '', replacements);

  showSendPreview({
    title: `Email Preview${dryRun ? ' · DRY RUN' : ''}`,
    meta: `<b>To:</b> ${escapeHtml(toEmail || '?')} · <b>Subject:</b> ${escapeHtml(subject || '(no subject)')}`,
    body: body || '(no email body set)',
    company: person.company || '',
    onConfirm: async () => {
      _sending = true;
      if (btn) btn.disabled = true;
      setMsgStatus(`${dryRun ? 'Simulating' : 'Emailing'} ${person.firstName} (${toEmail || '?'})…`);
      const res = await sendEmailToPerson(person);
      if (res?.success) {
        setMsgStatus(`✓ ${dryRun ? '[dry run] would email ' : 'Email sent to '}${toEmail}`);
        bumpSentTodayDisplay();
      } else if (res?.skipped) {
        setMsgStatus(`⏭ ${res.error}`);
      } else {
        setMsgStatus(`✗ Email failed: ${res?.error || 'unknown error'}`);
      }
      if (btn) btn.disabled = false;
      _sending = false;
    },
  });
}

function bumpSentTodayDisplay() {
  const el = $('sentTodayCount');
  el.textContent = (parseInt(el.textContent) || 0) + 1;
}

// ── Bulk send with pause/cancel ──────────────────────────────────────────────

const bulkState = {
  active: false,
  paused: false,
  cancelled: false,
  done: 0, failed: 0, skipped: 0,
};

function resetBulkState() {
  bulkState.active = false;
  bulkState.paused = false;
  bulkState.cancelled = false;
  bulkState.done = 0; bulkState.failed = 0; bulkState.skipped = 0;
}

// Selection state preserved across modal open/close so editing the template
// (or any other navigation) doesn't lose the user's picks. Keyed by mode so
// email and message selections don't bleed into each other.
const lastSelection = { email: null, message: null };

function personKey(p) {
  return [
    p.slug || '',
    (p.firstName || '').toLowerCase(),
    (p.lastName  || '').toLowerCase(),
    (p.email     || '').toLowerCase(),
  ].join('|');
}

function saveCurrentSelection(mode) {
  if (!$('selectionModal').classList.contains('show')) return;
  const set = new Set();
  $$('#selectionList .sel-chk:checked').forEach(c => {
    if (c.dataset.key) set.add(c.dataset.key);
  });
  lastSelection[mode] = set;
}

function clearSavedSelections() {
  lastSelection.email = null;
  lastSelection.message = null;
}

function showSelectionModal(people, mode) {
  const isEmail = mode === 'email';
  $('selModalTitle').textContent = `${isEmail ? '✉ Email' : '💬 Message'} — Select People (${people.length} total)`;

  storageGet(['msgTemplates', 'currentMsgTemplate', 'emailTemplates', 'currentEmailTemplate']).then(d => {
    if (isEmail) {
      const tpl = d.emailTemplates?.[d.currentEmailTemplate || DEFAULT_EMAIL_TEMPLATE];
      $('rawTemplatePreview').textContent = tpl?.subject || '(no email subject set)';
    } else {
      const tpl = d.msgTemplates?.[d.currentMsgTemplate || DEFAULT_MSG_TEMPLATE];
      $('rawTemplatePreview').textContent = tpl?.text || '(no message template set)';
    }
  });

  const savedKeys = lastSelection[mode];   // Set<string> or null

  $('selectionList').innerHTML = people.map((p, i) => {
    const key = personKey(p);
    const checked = savedKeys ? savedKeys.has(key) : true;
    const guessedEmail = isEmail ? (generateEmail(p) || '') : '';
    const emailField = isEmail
      ? `<input type="email" class="sel-email" data-idx="${i}"
            value="${escapeHtml(guessedEmail)}"
            placeholder="email@example.com"
            title="Click to edit if the guess is wrong"
            style="font-size:10px;color:var(--teal);background:var(--surface-2);border:1px solid var(--border);border-radius:3px;padding:2px 5px;min-width:200px;">`
      : '';
    const conn = `<span style="font-size:10px;color:${p.isConnected ? 'var(--green)' : 'var(--red)'}">${p.isConnected ? '✓' : '○'}</span>`;
    return `<div class="sel-item">
      <input type="checkbox" class="sel-chk" data-idx="${i}" data-key="${escapeHtml(key)}"${checked ? ' checked' : ''}>
      <span style="flex:1;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
        <b>${escapeHtml(p.firstName)} ${escapeHtml(p.lastName)}</b>
        ${conn}
        <span style="color:var(--text-3)">· ${escapeHtml(p.company || '—')}</span>
        ${emailField}
      </span>
    </div>`;
  }).join('');

  // Editable email override — typing into the per-row email field stashes the
  // value on the person object so generateEmail returns it and the send uses
  // the correction. Assignment (oninput =) avoids handler stacking on reopen.
  $('selectionList').oninput = isEmail ? (e => {
    const inp = e.target.closest('.sel-email');
    if (!inp) return;
    const idx = parseInt(inp.dataset.idx);
    const val = inp.value.trim();
    if (val && /^\S+@\S+\.\S+$/.test(val)) people[idx].email = val;
    else delete people[idx].email;
  }) : null;

  // "Find Emails" lookup loop (LinkedIn → Apollo → keep guess as-is)
  const findBtn = $('findEmailsBtn');
  if (findBtn) {
    findBtn.style.display = isEmail ? 'inline-flex' : 'none';
    findBtn.disabled = false;
    findBtn.textContent = '🔍 Find Emails';
    findBtn.onclick = () => runEmailDiscovery(people);
  }

  $('sendSelectedBtn').style.background = isEmail ? 'var(--teal)' : 'var(--green)';
  updateSendCount(isEmail);

  $('selectionModal').classList.add('show');
  $('bulkProgress').style.display = 'none';
  $('cancelBulkBtn').style.display = 'none';
  $('pauseBulkBtn').style.display = 'none';
  $('sendSelectedBtn').disabled = false;

  // Closing the modal preserves selections (so editing the template across a
  // close/reopen keeps your picks). "Reset" wipes them.
  const close = () => {
    saveCurrentSelection(mode);
    $('selectionModal').classList.remove('show');
  };

  $('selectAllChk').onchange = e => {
    $$('.sel-chk').forEach(c => c.checked = e.target.checked);
    updateSendCount(isEmail);
  };
  $('selectionList').onchange = () => updateSendCount(isEmail);
  $('selModalClose').onclick = close;
  $('cancelSelectionBtn').onclick = close;

  const resetBtn = $('resetSelectionBtn');
  if (resetBtn) {
    resetBtn.onclick = () => {
      lastSelection[mode] = null;
      $$('.sel-chk').forEach(c => c.checked = true);
      $('selectAllChk').checked = true;
      updateSendCount(isEmail);
    };
  }

  $('sendSelectedBtn').onclick = async () => {
    if (bulkState.active) return;
    const checked = [...$$('.sel-chk:checked')].map(c => parseInt(c.dataset.idx));
    const selected = checked.map(i => people[i]);
    if (!selected.length) return;
    // Snapshot the current selection before sending so a partial run that
    // gets paused/cancelled doesn't blow away the user's curated list.
    saveCurrentSelection(mode);
    await runBulkSend(selected, isEmail);
  };

  $('pauseBulkBtn').onclick = () => {
    bulkState.paused = !bulkState.paused;
    $('pauseBulkBtn').textContent = bulkState.paused ? '▶ Resume' : '⏸ Pause';
  };
  $('cancelBulkBtn').onclick = () => { bulkState.cancelled = true; };
}

// State for the email-discovery loop. Separate from bulkState so a discovery
// run can't be confused with an in-progress send.
const discoveryState = { active: false, cancelled: false };

async function runEmailDiscovery(people) {
  if (discoveryState.active) {
    // Second click → cancel
    discoveryState.cancelled = true;
    return;
  }
  const {
    useLinkedInScrape = true,
    useApollo = false,
    apolloApiKey = '',
  } = await storageGet(['useLinkedInScrape', 'useApollo', 'apolloApiKey']);

  if (!useLinkedInScrape && !useApollo) {
    setMsgStatus('Enable LinkedIn scrape or Apollo in Settings → Email Discovery first.');
    return;
  }
  if (useApollo && !apolloApiKey) {
    setMsgStatus('Apollo is enabled but no API key — add one in Settings.');
    return;
  }

  // Only look up rows that are currently checked AND don't already have a
  // manually-edited email (so we don't overwrite the user's corrections).
  const checkedIdxs = [...$$('#selectionList .sel-chk:checked')].map(c => parseInt(c.dataset.idx));
  const targets = checkedIdxs
    .map(i => ({ i, p: people[i] }))
    .filter(({ p }) => !p.email);   // skip ones already resolved

  if (!targets.length) {
    setMsgStatus('Nothing to look up — all selected rows already have an email.');
    return;
  }

  discoveryState.active = true;
  discoveryState.cancelled = false;
  const findBtn = $('findEmailsBtn');
  const sendBtn = $('sendSelectedBtn');
  if (sendBtn) sendBtn.disabled = true;

  let resolved = 0, failed = 0, gated = 0;
  for (let n = 0; n < targets.length; n++) {
    if (discoveryState.cancelled) break;
    const { i, p } = targets[n];
    if (findBtn) findBtn.textContent = `⏹ Cancel (${n + 1}/${targets.length})`;
    setMsgStatus(`🔍 Looking up ${p.firstName} ${p.lastName}…`);

    let found = null;

    // 1) LinkedIn Contact-Info (best for 1st-degree connections)
    if (useLinkedInScrape && p.slug) {
      const r = await chrome.runtime.sendMessage({ action: 'scrapeLinkedInEmail', slug: p.slug });
      if (r?.success && r.email) found = r.email;
      else if (r?.error === 'Not authenticated to LinkedIn') gated++;
    }

    // 2) Apollo API
    if (!found && useApollo && apolloApiKey) {
      const r = await chrome.runtime.sendMessage({
        action: 'lookupApollo',
        firstName: p.firstName, lastName: p.lastName, company: p.company,
        apiKey: apolloApiKey,
      });
      if (r?.success && r.email) found = r.email;
    }

    if (found) {
      p.email = found;
      resolved++;
      // Update the row's email input in-place
      const input = document.querySelector(`#selectionList .sel-email[data-idx="${i}"]`);
      if (input) {
        input.value = found;
        input.style.color = 'var(--green)';
      }
    } else {
      failed++;
    }
    await wait(400);  // gentle pacing
  }

  discoveryState.active = false;
  if (findBtn) {
    findBtn.textContent = '🔍 Find Emails';
    findBtn.disabled = false;
  }
  if (sendBtn) sendBtn.disabled = false;

  const parts = [`${resolved} found`];
  if (failed) parts.push(`${failed} fell back to guess`);
  if (gated)  parts.push(`${gated} need LinkedIn sign-in`);
  if (discoveryState.cancelled) parts.push('(cancelled)');
  setMsgStatus(`✓ Lookup done: ${parts.join(', ')}.`);
}

async function runBulkSend(selected, isEmail) {
  const { sendDelay = 1500, emailDelay = 800, dryRun = false } =
    await storageGet(['sendDelay', 'emailDelay', 'dryRun']);
  const delayMs = isEmail ? emailDelay : sendDelay;

  resetBulkState();
  bulkState.active = true;
  $('sendSelectedBtn').disabled = true;
  $('cancelSelectionBtn').disabled = true;
  $('bulkProgress').style.display = 'block';
  $('cancelBulkBtn').style.display = 'inline-flex';
  $('pauseBulkBtn').style.display = 'inline-flex';
  $('pauseBulkBtn').textContent = '⏸ Pause';
  $('bulkProgressLabel').textContent =
    `${isEmail ? 'Emailing' : 'Sending'} 0/${selected.length}…`;
  updateBulkProgress(0, selected.length);

  for (let i = 0; i < selected.length; i++) {
    if (bulkState.cancelled) break;
    while (bulkState.paused && !bulkState.cancelled) await wait(300);
    if (bulkState.cancelled) break;

    const person = selected[i];
    const rl = await checkRateLimitBeforeSend(isEmail ? 'email' : (person.isConnected ? 'message' : 'connect'));
    if (!rl.allowed) {
      setMsgStatus(`⏸ ${rl.reason}. Bulk send paused.`);
      $('bulkProgressLabel').textContent = `⏸ Paused — ${rl.reason}`;
      bulkState.paused = true;
      $('pauseBulkBtn').textContent = '▶ Resume';
      i--; // retry this person on resume
      continue;
    }

    $('bulkProgressLabel').textContent =
      `${isEmail ? 'Emailing' : 'Sending'} ${i + 1}/${selected.length}: ${person.firstName}…`;
    setMsgStatus($('bulkProgressLabel').textContent);

    const res = isEmail ? await sendEmailToPerson(person) : await dispatchMessage(person);
    if (res?.success) {
      bulkState.done++;
      if (isEmail && !dryRun) bumpSentTodayDisplay();
    } else if (res?.skipped) {
      bulkState.skipped++;
    } else {
      bulkState.failed++;
    }
    updateBulkProgress(i + 1, selected.length);
    await wait(delayMs);
  }

  const parts = [`${bulkState.done} sent`];
  if (bulkState.skipped) parts.push(`${bulkState.skipped} skipped`);
  if (bulkState.failed)  parts.push(`${bulkState.failed} failed`);
  if (bulkState.cancelled) parts.push('(stopped)');
  setMsgStatus(`Done: ${parts.join(', ')}.`);

  bulkState.active = false;
  $('selectionModal').classList.remove('show');
  $('cancelSelectionBtn').disabled = false;
  $('sendSelectedBtn').disabled = false;
}

function updateBulkProgress(done, total) {
  $('bulkProgressCount').textContent = `${done}/${total}`;
  $('bulkProgressBar').style.width = `${total ? (done / total) * 100 : 0}%`;
}

function updateSendCount(isEmail) {
  const n = $$('.sel-chk:checked').length;
  $('sendSelectedBtn').textContent = isEmail ? `✉ Email Selected (${n})` : `💬 Send to Selected (${n})`;
  $('selCount').textContent = `${n} selected`;
}

function handleMessageAllPage() { showSelectionModal(getFilteredPeople(), 'message'); }
function handleEmailAllPage()   { showSelectionModal(getFilteredPeople(), 'email'); }

function nextPage() {
  const perPage = getPeoplePerPage();
  const totalPages = Math.ceil(allPeople.length / perPage);
  if (currentPage < totalPages - 1) { currentPage++; renderPeoplePage(); }
}
function prevPage() { if (currentPage > 0) { currentPage--; renderPeoplePage(); } }

// ── CSV import ───────────────────────────────────────────────────────────────

function parseCsv(text) {
  // Very small parser — handles quoted fields with commas + escaped quotes
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cell += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (cell || row.length) { row.push(cell); rows.push(row); row = []; cell = ''; }
        if (c === '\r' && text[i + 1] === '\n') i++;
      } else cell += c;
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function onCsvFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const rows = parseCsv(text).filter(r => r.length && r.some(c => c.trim()));
  if (!rows.length) return setMsgStatus('CSV is empty.');

  // Detect headers
  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = {
    firstName: header.findIndex(h => /first/.test(h)),
    lastName:  header.findIndex(h => /last/.test(h)),
    company:   header.findIndex(h => /company|org|employer/.test(h)),
    email:     header.findIndex(h => /^email|e-mail/.test(h)),
  };
  const startRow = (idx.firstName >= 0 || idx.lastName >= 0 || idx.email >= 0) ? 1 : 0;

  allPeople = rows.slice(startRow).map(r => ({
    firstName: idx.firstName >= 0 ? (r[idx.firstName] || '').trim() : (r[0] || '').trim(),
    lastName:  idx.lastName  >= 0 ? (r[idx.lastName]  || '').trim() : (r[1] || '').trim(),
    company:   idx.company   >= 0 ? (r[idx.company]   || '').trim() : (r[2] || '').trim(),
    email:     idx.email     >= 0 ? (r[idx.email]     || '').trim() : '',
    slug:      '', profileId: '', isConnected: false,
  })).filter(p => p.firstName || p.email);

  clearSavedSelections();
  currentPage = 0;
  $('peopleListContainer').style.display = 'block';
  renderPeoplePage();
  setMsgStatus(`✓ Imported ${allPeople.length} people from CSV. Note: LinkedIn messaging is disabled for CSV imports (no profile data).`);
  $('csvFile').value = ''; // allow re-import of same file
}

// ── Cache indicator ──────────────────────────────────────────────────────────

function formatCacheAge(builtAt) {
  if (!builtAt) return '—';
  const ageMs = Date.now() - builtAt;
  if (ageMs < 60000)   return 'just now';
  if (ageMs < 3600000) return `${Math.floor(ageMs / 60000)}m`;
  return `${Math.floor(ageMs / 3600000)}h`;
}

function updateCacheStats(res) {
  const pill = $('cacheIndicator');
  if (!res || !res.success || res.cacheSize === null) {
    pill.style.display = 'none';
  } else if (res.building) {
    pill.style.display = 'inline-flex';
    pill.textContent = '⟳ updating…';
    pill.style.background = 'var(--warn-soft)';
    pill.style.color = 'var(--warn)';
  } else {
    pill.style.display = 'inline-flex';
    pill.textContent = `cache: ${res.cacheSize} contacts`;
    pill.style.background = 'var(--primary-soft)';
    pill.style.color = 'var(--primary)';
  }

  const setVal = (id, v, updating = false) => {
    const el = $(id); if (!el) return;
    el.textContent = v; el.classList.toggle('updating', updating);
  };
  if (!res || !res.success) return;
  if (res.building) {
    setVal('cacheContactCount', '…', true);
    setVal('cacheSizeKb', '…', true);
    setVal('cacheAge', '…', true);
  } else if (res.cacheSize !== null) {
    setVal('cacheContactCount', res.cacheSize.toLocaleString());
    setVal('cacheSizeKb', res.sizeBytes != null ? (res.sizeBytes / 1024).toFixed(1) : '—');
    setVal('cacheAge', formatCacheAge(res.cacheBuiltAt));
  } else {
    setVal('cacheContactCount', '—');
    setVal('cacheSizeKb', '—');
    setVal('cacheAge', '—');
  }
}

async function refreshCacheIndicator() {
  const res = await chrome.runtime.sendMessage({ action: 'getCacheSize' }).catch(() => null);
  updateCacheStats(res);
  if (res?.building) setTimeout(refreshCacheIndicator, 1500);
}

function setGmailStatus(msg, color = 'var(--text-3)') {
  const el = $('gmailAuthStatus');
  el.textContent = msg;
  el.style.color = color;
}

// ── Activity log + stats ─────────────────────────────────────────────────────

async function renderActivity() {
  const filter = $('activityFilter').value;
  const res = await chrome.runtime.sendMessage({ action: 'getActivityLog' });
  if (!res?.success) {
    $('activityList').innerHTML = '<div class="empty-state">Could not load activity log.</div>';
    return;
  }
  const log = (res.log || []).filter(e => {
    if (filter === 'all')    return true;
    if (filter === 'failed') return e.status === 'failed';
    return e.channel === filter;
  });
  if (!log.length) {
    $('activityList').innerHTML = '<div class="empty-state">No activity yet. Send a message or email to see it here.</div>';
    return;
  }
  $('activityList').innerHTML = log.map(e => {
    const when = new Date(e.ts).toLocaleString();
    return `<div class="activity-item">
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <span class="activity-channel ${e.channel}">${e.channel}</span>
          <b>${escapeHtml(e.target || '?')}</b>
          ${e.company ? `<span class="activity-meta">· ${escapeHtml(e.company)}</span>` : ''}
          <span class="activity-status ${e.status}">${e.status === 'sent' ? '✓' : '✗'} ${e.status}</span>
        </div>
        ${e.email ? `<div class="activity-meta">${escapeHtml(e.email)}${e.subject ? ' · ' + escapeHtml(e.subject) : ''}</div>` : ''}
        ${e.error ? `<div class="activity-meta" style="color:var(--red)">${escapeHtml(e.error)}</div>` : ''}
      </div>
      <div class="activity-meta" style="text-align:right;white-space:nowrap;">${when}</div>
    </div>`;
  }).join('');
}

async function exportActivity() {
  const res = await chrome.runtime.sendMessage({ action: 'getActivityLog' });
  const log = (res?.log) || [];
  if (!log.length) return;
  const header = 'Timestamp,Channel,Status,Target,Company,Email,Subject,Error';
  const rows = log.map(e => [
    new Date(e.ts).toISOString(),
    e.channel || '',
    e.status || '',
    e.target  || '',
    e.company || '',
    e.email   || '',
    e.subject || '',
    e.error   || '',
  ].map(csvEscape).join(',')).join('\n');
  const blob = new Blob([header + '\n' + rows], { type: 'text/csv' });
  chrome.downloads.download({
    url: URL.createObjectURL(blob),
    filename: `linkedin_activity_${new Date().toISOString().slice(0, 10)}.csv`,
    saveAs: false,
  });
}

async function clearActivity() {
  if (!confirm('Clear the entire activity log?')) return;
  await chrome.runtime.sendMessage({ action: 'clearActivityLog' });
  renderActivity();
}

async function renderStats() {
  const res = await chrome.runtime.sendMessage({ action: 'getSendStats' });
  if (!res?.success) return;
  const stats = res.stats || {};
  const today = new Date().toISOString().slice(0, 10);
  const t = stats[today] || { email: 0, message: 0, connect: 0 };
  $('statEmailToday').textContent = t.email   || 0;
  $('statMsgToday').textContent   = t.message || 0;
  $('statConnToday').textContent  = t.connect || 0;

  // Last 7 days
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    days.push({ date: d, ...(stats[d] || { email: 0, message: 0, connect: 0 }) });
  }
  const total7 = days.reduce((a, d) => a + (d.email || 0) + (d.message || 0) + (d.connect || 0), 0);
  $('statTotal7').textContent = total7;

  drawStatsChart(days);
}

function drawStatsChart(days) {
  const svg = $('statsChart');
  svg.innerHTML = '';
  const W = 580, H = 120, P = 12;
  const maxVal = Math.max(1, ...days.map(d => (d.email || 0) + (d.message || 0) + (d.connect || 0)));
  const barWidth = (W - P * 2) / days.length;
  const groupGap = 4;
  const inner = barWidth - groupGap;
  const segW = inner / 3;
  const channels = [
    { key: 'email',   color: 'var(--green)' },
    { key: 'message', color: 'var(--primary)' },
    { key: 'connect', color: 'var(--warn)' },
  ];

  days.forEach((d, i) => {
    const x0 = P + i * barWidth;
    channels.forEach((ch, ci) => {
      const v = d[ch.key] || 0;
      const h = ((H - 30) * v) / maxVal;
      const x = x0 + ci * segW;
      const y = H - 16 - h;
      svg.innerHTML += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" `
        + `width="${(segW - 1).toFixed(1)}" height="${h.toFixed(1)}" `
        + `fill="${ch.color}" rx="1"></rect>`;
      if (v > 0)
        svg.innerHTML += `<text x="${(x + segW / 2).toFixed(1)}" y="${(y - 2).toFixed(1)}" `
          + `font-size="8" text-anchor="middle" fill="var(--text-2)">${v}</text>`;
    });
    const label = d.date.slice(5); // MM-DD
    svg.innerHTML += `<text x="${(x0 + inner / 2).toFixed(1)}" y="${H - 2}" `
      + `font-size="9" text-anchor="middle" fill="var(--text-3)">${label}</text>`;
  });
}

// ── Data export / wipe ───────────────────────────────────────────────────────

async function exportAllData() {
  const data = await new Promise(res => chrome.storage.local.get(null, res));
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  chrome.downloads.download({
    url: URL.createObjectURL(blob),
    filename: `linkedin_helper_backup_${new Date().toISOString().slice(0, 10)}.json`,
    saveAs: true,
  });
}

async function resetAllData() {
  if (!confirm('Reset ALL data?\nThis will delete templates, cache, activity log and settings. Cannot be undone.')) return;
  if (!confirm('Are you absolutely sure?')) return;
  await new Promise(res => chrome.storage.local.clear(res));
  location.reload();
}

// ── Misc helpers ─────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
const wait = ms => new Promise(r => setTimeout(r, ms));

// ── One-time migration from v1 storage layout ───────────────────────────────

async function migrateFromV1() {
  const { _migratedV2, messageTemplate, emailSubject, emailBody } =
    await storageGet(['_migratedV2', 'messageTemplate', 'emailSubject', 'emailBody']);
  if (_migratedV2) return;

  const updates = { _migratedV2: true };
  if (messageTemplate) {
    const { msgTemplates = {} } = await storageGet('msgTemplates');
    if (!msgTemplates[DEFAULT_MSG_TEMPLATE]) {
      msgTemplates[DEFAULT_MSG_TEMPLATE] = { text: messageTemplate };
      updates.msgTemplates = msgTemplates;
    }
  }
  if (emailSubject || emailBody) {
    const { emailTemplates = {} } = await storageGet('emailTemplates');
    if (!emailTemplates[DEFAULT_EMAIL_TEMPLATE]) {
      emailTemplates[DEFAULT_EMAIL_TEMPLATE] = {
        subject: emailSubject || '',
        body:    emailBody    || '',
      };
      updates.emailTemplates = emailTemplates;
    }
  }
  await storageSet(updates);
}

// ── Initial render ───────────────────────────────────────────────────────────

async function load() {
  await migrateFromV1();
  await applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  const { flushAt } = await loadSettings();
  const { buffer = [], userFormats = {} } = await storageGet(['buffer', 'userFormats']);
  _userFormats = userFormats;
  renderTable(buffer);
  setCounter(buffer.length, flushAt);
}

// ── Event listeners ──────────────────────────────────────────────────────────

$$('.tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

// Scrape
$('search').addEventListener('click', search);
$('export').addEventListener('click', manualExport);
$('clear').addEventListener('click', clearStorage);
$('configToggle').addEventListener('click', toggleConfig);
$('cfgAdd').addEventListener('click', addCompanyFormat);
$('cfgCompany').addEventListener('keydown', e => e.key === 'Enter' && addCompanyFormat());
$('q').addEventListener('keydown', e => e.key === 'Enter' && search());
$('flushAt').addEventListener('change', saveScrapeSettings);
$('maxPages').addEventListener('change', saveScrapeSettings);

// Message templates
$('saveMessage').addEventListener('click', saveMessageConfig);
$('msgTemplateSelect').addEventListener('change', onMsgTemplateChange);
$('msgTemplateSave').addEventListener('click', saveAsMessageTemplate);
$('msgTemplateDelete').addEventListener('click', deleteMessageTemplate);
$('replaceAdd').addEventListener('click', addReplacement);
$('replaceKeyword').addEventListener('keydown', e => e.key === 'Enter' && addReplacement());
$('replaceAddEmail').addEventListener('click', addReplacementEmail);
$('replaceKeywordEmail').addEventListener('keydown', e => e.key === 'Enter' && addReplacementEmail());
$('caseSensitive').addEventListener('change', saveMessagingFlags);
$('dryRun').addEventListener('change', saveMessagingFlags);

// Email templates
$('saveEmailConfig').addEventListener('click', saveEmailConfig);
$('emailTemplateSelect').addEventListener('change', onEmailTemplateChange);
$('emailTemplateSave').addEventListener('click', saveAsEmailTemplate);
$('emailTemplateDelete').addEventListener('click', deleteEmailTemplate);

// Outreach search
$('msgSearch').addEventListener('click', searchPeopleForMessaging);
$('msgQuery').addEventListener('keydown', e => e.key === 'Enter' && searchPeopleForMessaging());
$('prevPage').addEventListener('click', prevPage);
$('nextPage').addEventListener('click', nextPage);
$('connFilter').addEventListener('change', () => { currentPage = 0; renderPeoplePage(); });
$('messageAllPage').addEventListener('click', handleMessageAllPage);
$('emailAllPage').addEventListener('click', handleEmailAllPage);

// CSV import
$('importCsv').addEventListener('click', () => $('csvFile').click());
$('csvFile').addEventListener('change', onCsvFile);

// Config card tab switching
$$('.cfg-subtab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.cfg-subtab').forEach(t => t.classList.remove('active'));
    $$('.cfg-subpanel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(tab.dataset.cfg).classList.add('active');
  });
});

// Email sub-tabs
$$('.email-subtab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.email-subtab').forEach(t => t.classList.remove('active'));
    $$('.email-subpanel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(tab.dataset.epanel).classList.add('active');
    if (tab.dataset.epanel === 'emailGmailPanel') refreshCacheIndicator();
  });
});

// Collapsible config card
let _cfgCardOpen = true;
$('cfgCardToggle').addEventListener('click', () => {
  _cfgCardOpen = !_cfgCardOpen;
  $('cfgCardBody').classList.toggle('collapsed', !_cfgCardOpen);
  $('cfgCardToggle').textContent = _cfgCardOpen ? '▲ collapse' : '▼ expand';
});

// Exclude dropdown
$('excludeToggle').addEventListener('click', e => {
  e.stopPropagation();
  $('excludeDropdown').classList.toggle('open');
});
document.addEventListener('click', e => {
  if (!$('excludeWrap').contains(e.target)) $('excludeDropdown').classList.remove('open');
});
$('excludeInput').addEventListener('blur', () => { saveExcludeInput(); updateExcludeToggle(); });
$('excludeInput').addEventListener('input', updateExcludeToggle);

// Duplicate prevention controls
$('skipRecentEmails').addEventListener('change', function () {
  $('skipDaysRow').style.display = this.checked ? 'flex' : 'none';
  saveEmailConfig();
});
$('foreverChk').addEventListener('change', function () {
  $('skipEmailDays').disabled = this.checked;
  saveEmailConfig();
});
$('skipEmailDays').addEventListener('change', saveEmailConfig);

// Gmail / cache buttons
$('authorizeGmail').addEventListener('click', async () => {
  setGmailStatus('Authorizing…');
  updateCacheStats({ success: true, building: true, cacheSize: null });
  const authRes = await chrome.runtime.sendMessage({ action: 'authorizeGmail' });
  if (!authRes?.success) {
    setGmailStatus(`✗ ${authRes?.error || 'Auth failed'}`, 'var(--red)');
    updateCacheStats(null);
    return;
  }
  setGmailStatus('Loading contacts from Gmail…');
  const { skipEmailDays = 7 } = await storageGet('skipEmailDays');
  const cacheRes = await chrome.runtime.sendMessage({ action: 'refreshSentCache', skipEmailDays });
  if (cacheRes?.success) {
    const w = skipEmailDays === 0 ? 'all time' : `last ${skipEmailDays}d`;
    setGmailStatus(`✓ Connected (${w})`, 'var(--green)');
    updateCacheStats({ ...cacheRes, building: false });
  } else {
    setGmailStatus(`✗ ${cacheRes?.error || 'Cache build failed'}`, 'var(--red)');
    updateCacheStats(null);
  }
});

$('refreshSentCache').addEventListener('click', async () => {
  setGmailStatus('Flushing & rebuilding from Gmail…');
  updateCacheStats({ success: true, building: true, cacheSize: null });
  const { skipEmailDays = 7 } = await storageGet('skipEmailDays');
  const res = await chrome.runtime.sendMessage({ action: 'refreshSentCache', skipEmailDays });
  if (res?.success) {
    const w = skipEmailDays === 0 ? 'all time' : `last ${skipEmailDays}d`;
    setGmailStatus(`✓ Cache rebuilt (${w})`, 'var(--green)');
    updateCacheStats({ ...res, building: false });
  } else {
    setGmailStatus(`✗ ${res?.error || 'Refresh failed'}`, 'var(--red)');
    updateCacheStats(null);
  }
});

$('fetchSentToday').addEventListener('click', async () => {
  const btn = $('fetchSentToday'), countEl = $('sentTodayCount');
  btn.disabled = true; btn.textContent = '…'; countEl.textContent = '…';
  const res = await chrome.runtime.sendMessage({ action: 'fetchSentTodayFromGmail' }).catch(() => null);
  btn.disabled = false; btn.textContent = '↺ Sent today';
  if (res?.success) {
    countEl.textContent = res.count;
    setGmailStatus(`↺ ${res.sent} sent · ${res.bounced} bounced · ${res.count} delivered`, 'var(--primary)');
  } else {
    countEl.textContent = '✗';
    setGmailStatus(`✗ ${res?.error || 'Failed to fetch'}`, 'var(--red)');
  }
});

// Activity tab
$('activityFilter').addEventListener('change', renderActivity);
$('exportActivity').addEventListener('click', exportActivity);
$('clearActivity').addEventListener('click', clearActivity);

// Settings tab
$('rateLimitEnabled').addEventListener('change', saveRateLimitSettings);
$('maxPerHour').addEventListener('change', saveRateLimitSettings);
$('maxPerDay').addEventListener('change', saveRateLimitSettings);
$('sendDelay').addEventListener('change', saveSendBehaviour);
$('emailDelay').addEventListener('change', saveSendBehaviour);

// Email discovery
$('useLinkedInScrape').addEventListener('change', saveEmailDiscoverySettings);
$('useApollo').addEventListener('change', saveEmailDiscoverySettings);
$('apolloApiKey').addEventListener('change', saveEmailDiscoverySettings);
$('apolloTestBtn').addEventListener('click', testApolloKey);
$$('input[name="theme"]').forEach(r => r.addEventListener('change', () => setTheme(r.value)));
$('themeToggle').addEventListener('click', toggleTheme);
$('exportAllData').addEventListener('click', exportAllData);
$('clearAllData').addEventListener('click', resetAllData);

// ── Bootstrap ────────────────────────────────────────────────────────────────
load();
loadEmailConfig();
loadMessageConfig();
loadExcludeInput();
loadEmailDiscoverySettings();
