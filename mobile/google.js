// Google Docs + Google Sheets for M.A.S.T.E.R, straight from the phone's browser.
//
// Sign-in uses Google's "device" flow: the app shows a short code, you approve it at
// google.com/device, and the app receives a token. No popup, no redirect and no web address
// to register, so it also works from a page opened off a pendrive.
//
// Permission requested: drive.file ONLY. M.A.S.T.E.R can create documents and spreadsheets
// and edit the ones it created - it cannot see or touch any other file in your Drive.
//
// You supply your own Google Cloud "TVs and Limited Input devices" client (see
// GOOGLE-SETUP.md). Nothing here is a shared credential, and nothing is bundled in the repo.

import { store, getSettings } from './store.js';

export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DEVICE_PAGE = 'https://www.google.com/device';
const DEVICE_URL = 'https://oauth2.googleapis.com/device/code';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DOCS_URL = 'https://docs.googleapis.com/v1/documents';
const SHEETS_URL = 'https://sheets.googleapis.com/v4/spreadsheets';
const SLIDES_URL = 'https://slides.googleapis.com/v1/presentations';
const MAX_WAIT_SEC = 240; // how long to wait for you to approve the sign-in

export class GoogleError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'setup' | 'denied' | 'timeout' | 'network' | 'api' | 'notfound'
  }
}

let sleepImpl = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

let access = null; // { token, expiresAt } - kept in memory only

export const _test = {
  setSleep(fn) { sleepImpl = fn; },
  dropAccessToken() { access = null; },
};

// ---------- settings & state ----------

const creds = () => {
  const s = getSettings();
  return { id: String(s.googleClientId || '').trim(), secret: String(s.googleClientSecret || '').trim() };
};
export const isConfigured = () => { const c = creds(); return !!(c.id && c.secret); };

const saved = () => store.get('google', {});
export const isConnected = () => !!(saved().refresh || (access && access.expiresAt > Date.now()));

export const SETUP_HELP =
  "Google Docs, Sheets and Slides aren't set up yet. Open settings (the gear), find the Google section, and follow " +
  'its "How to get these" link - it takes about ten minutes, once - then paste the Client ID and secret.';

// ---------- sign-in (device flow) ----------

async function post(url, params, signal) {
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new GoogleError('network', "I can't reach Google right now.");
  }
  let json = {};
  try { json = await r.json(); } catch { /* not JSON */ }
  return { ok: r.ok, status: r.status, json };
}

function oauthProblem(json) {
  const e = json?.error;
  if (e === 'invalid_client' || e === 'unauthorized_client' || e === 'invalid_request') {
    return new GoogleError('setup',
      "Google didn't accept the Client ID / secret. Check both in settings - the client type must be " +
      '"TVs and Limited Input devices".');
  }
  if (e === 'access_denied') {
    return new GoogleError('denied',
      'Google blocked the sign-in. If your project is in Testing mode, add your Google account under "Test users".');
  }
  if (e === 'expired_token') return new GoogleError('timeout', 'The sign-in code expired before it was approved. Ask again to get a new one.');
  return new GoogleError('api', `Google sign-in failed${e ? ` (${e})` : ''}.`);
}

async function refreshAccess(signal) {
  const rt = saved().refresh;
  if (!rt) return false;
  const c = creds();
  const r = await post(TOKEN_URL, {
    client_id: c.id, client_secret: c.secret, refresh_token: rt, grant_type: 'refresh_token',
  }, signal);
  if (r.ok && r.json.access_token) {
    access = { token: r.json.access_token, expiresAt: Date.now() + (Number(r.json.expires_in) || 3600) * 1000 };
    return true;
  }
  if (r.json.error === 'invalid_grant' || r.json.error === 'invalid_client') {
    const s = saved();
    delete s.refresh;
    store.set('google', s); // the saved sign-in no longer works - sign in again
  }
  return false;
}

// Shows a code, waits for you to approve it at google.com/device, stores the tokens.
export async function connect({ signal, onCode } = {}) {
  const c = creds();
  if (!c.id || !c.secret) throw new GoogleError('setup', SETUP_HELP);
  const d = await post(DEVICE_URL, { client_id: c.id, scope: SCOPE }, signal);
  if (!d.ok || !d.json.device_code) throw oauthProblem(d.json);

  const url = d.json.verification_url || d.json.verification_uri || DEVICE_PAGE;
  if (onCode) onCode({ code: d.json.user_code, url });

  const limit = Math.min(Number(d.json.expires_in) || 1800, MAX_WAIT_SEC);
  let interval = Math.max(Number(d.json.interval) || 5, 3);
  let waited = 0;
  for (;;) {
    await sleepImpl(interval * 1000, signal);
    waited += interval;
    const r = await post(TOKEN_URL, {
      client_id: c.id, client_secret: c.secret, device_code: d.json.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }, signal);
    if (r.ok && r.json.access_token) {
      access = { token: r.json.access_token, expiresAt: Date.now() + (Number(r.json.expires_in) || 3600) * 1000 };
      if (r.json.refresh_token) store.set('google', { ...saved(), refresh: r.json.refresh_token });
      return;
    }
    const err = r.json.error;
    if (err === 'authorization_pending') {
      if (waited >= limit) throw new GoogleError('timeout', "The sign-in wasn't approved in time. Ask again to get a new code.");
      continue;
    }
    if (err === 'slow_down') { interval += 5; continue; }
    throw oauthProblem(r.json);
  }
}

export async function getToken(opts = {}) {
  if (access && access.expiresAt - 60000 > Date.now()) return access.token;
  if (await refreshAccess(opts.signal)) return access.token;
  await connect(opts);
  return access.token;
}

export async function disconnect() {
  const token = saved().refresh || access?.token;
  access = null;
  store.remove('google');
  if (token) {
    try {
      await fetch(REVOKE_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      });
    } catch { /* best effort */ }
  }
}

// ---------- API calls ----------

function apiProblem(status, json) {
  const msg = String(json?.error?.message || '');
  const activation = /https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"')]+/.exec(
    msg + ' ' + JSON.stringify(json?.error?.details || ''))?.[0];
  if (status === 403 && (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg + JSON.stringify(json?.error?.details || '')))) {
    return new GoogleError('setup',
      'That Google service is not switched on for your project yet. Open ' +
      (activation || 'console.cloud.google.com, APIs & Services, Library') +
      ', press Enable, wait a minute, then ask again.');
  }
  if (status === 403) {
    return new GoogleError('denied', "Google won't allow that. M.A.S.T.E.R can only work on documents it created itself.");
  }
  if (status === 404) {
    return new GoogleError('notfound', "Google can't find that file - or M.A.S.T.E.R didn't create it (it can only open its own documents).");
  }
  if (status === 429) return new GoogleError('api', 'Google is rate-limiting me. Wait a minute and try again.');
  return new GoogleError('api', `Google rejected the request${msg ? `: ${msg}` : ` (${status})`}.`);
}

async function api(method, url, body, opts = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(opts);
    let r;
    try {
      r = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: opts.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new GoogleError('network', "I can't reach Google right now.");
    }
    if (r.status === 401 && attempt === 0) { access = null; continue; } // token went stale - get a fresh one
    let json = {};
    try { const t = await r.text(); json = t ? JSON.parse(t) : {}; } catch { /* not JSON */ }
    if (r.ok) return json;
    throw apiProblem(r.status, json);
  }
  throw new GoogleError('api', 'Google would not accept the sign-in. Try again.');
}

// ---------- the documents M.A.S.T.E.R has made (so "add to my notes doc" works) ----------

const files = () => store.get('gfiles', []);
function remember(f) {
  const list = files().filter((x) => x.id !== f.id);
  list.unshift({ ...f, at: Date.now() });
  store.set('gfiles', list.slice(0, 30));
}
export const listFiles = () => files();

export function findFile(which, type) {
  const all = files();
  const list = all.filter((f) => !type || f.type === type);
  if (!list.length) return null;
  const q = String(which ?? '').trim().toLowerCase();
  if (!q || ['last', 'latest', 'recent', 'it', 'that', 'this'].includes(q)) return list[0];
  if (/^\d+$/.test(q)) { // the number in "list my Google files" - counted over everything, then checked for kind
    const f = all[Number(q) - 1];
    return f && (!type || f.type === type) ? f : null;
  }
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  return list.find((f) => words.length && words.every((w) => f.title.toLowerCase().includes(w)))
    || list.find((f) => words.some((w) => f.title.toLowerCase().includes(w)))
    || null;
}

// ---------- text -> Google Docs ----------

const clean = (t) => String(t ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

function inline(text) {
  const runs = [];
  const re = /\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push({ t: text.slice(last, m.index) });
    if (m[1] !== undefined) runs.push({ t: m[1], b: true });
    else runs.push({ t: m[2], i: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ t: text.slice(last) });
  return runs.length ? runs : [{ t: '' }];
}

// "# heading", "## sub", "- bullet", "1. numbered", **bold**, *italic*, blank line between paragraphs.
export function parseMarkup(content) {
  const out = [];
  let table = [];
  const flushTable = () => {
    for (const row of table) out.push({ type: 'p', runs: inline(row.join('  |  ')) });
    table = [];
  };
  for (const raw of String(content ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flushTable(); continue; }
    if (/^\s*\|/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) table.push(cells);
      continue;
    }
    flushTable();
    let m;
    if (/^\s*([-*_]\s*){3,}$/.test(line)) continue;
    if ((m = /^\s*(#{1,3})\s+(.*)$/.exec(line))) out.push({ type: `h${m[1].length}`, runs: inline(m[2]) });
    else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) out.push({ type: 'bullet', runs: inline(m[1]) });
    else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) out.push({ type: 'number', runs: inline(m[1]) });
    else out.push({ type: 'p', runs: inline(line.trim()) });
  }
  flushTable();
  return out;
}

const PARA_STYLE = { title: 'TITLE', h1: 'HEADING_1', h2: 'HEADING_2', h3: 'HEADING_3', p: 'NORMAL_TEXT', bullet: 'NORMAL_TEXT', number: 'NORMAL_TEXT' };
const LIST_PRESET = { bullet: 'BULLET_DISC_CIRCLE_SQUARE', number: 'NUMBERED_DECIMAL_ALPHA_ROMAN' };

// Turns parsed blocks into Docs batchUpdate requests. Docs positions count UTF-16 units
// starting at 1, which is exactly what JS string lengths give.
//   base          where the text goes (1 = a new empty doc, or end-1 to append)
//   newline       start with a line break (appending after existing text)
//   explicitNormal also reset ordinary paragraphs to Normal (so they don't inherit a heading)
//   clearBullets  stop new plain paragraphs joining a bulleted list the doc ended on
export function buildDocRequests(blocks, { base = 1, newline = false, explicitNormal = false, clearBullets = false } = {}) {
  let pos = base + (newline ? 1 : 0);
  const paras = [];
  const texts = [];
  for (const b of blocks) {
    const start = pos;
    let plain = '';
    const spans = [];
    for (const r of b.runs) {
      const t = clean(r.t);
      if ((r.b || r.i) && t) spans.push({ start: start + plain.length, end: start + plain.length + t.length, b: !!r.b, i: !!r.i });
      plain += t;
    }
    paras.push({ type: b.type, start, end: start + plain.length + 1, spans });
    texts.push(plain);
    pos = start + plain.length + 1;
  }
  const requests = [{ insertText: { location: { index: base }, text: (newline ? '\n' : '') + texts.join('\n') } }];

  for (const p of paras) {
    const style = PARA_STYLE[p.type];
    if (style !== 'NORMAL_TEXT' || explicitNormal) {
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: p.start, endIndex: p.end },
          paragraphStyle: { namedStyleType: style }, fields: 'namedStyleType',
        },
      });
    }
    if (clearBullets && !LIST_PRESET[p.type]) {
      requests.push({ deleteParagraphBullets: { range: { startIndex: p.start, endIndex: p.end } } });
    }
  }
  for (let i = 0; i < paras.length; i++) {
    const kind = LIST_PRESET[paras[i].type] && paras[i].type;
    if (!kind) continue;
    let j = i;
    while (j + 1 < paras.length && paras[j + 1].type === kind) j++;
    requests.push({
      createParagraphBullets: {
        range: { startIndex: paras[i].start, endIndex: paras[j].end }, bulletPreset: LIST_PRESET[kind],
      },
    });
    i = j;
  }
  for (const p of paras) {
    for (const s of p.spans) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: s.start, endIndex: s.end },
          textStyle: { ...(s.b ? { bold: true } : {}), ...(s.i ? { italic: true } : {}) },
          fields: [s.b ? 'bold' : '', s.i ? 'italic' : ''].filter(Boolean).join(','),
        },
      });
    }
  }
  return { requests, paras };
}

// ---------- Google Docs ----------

export async function createDoc(title, content, opts = {}) {
  const name = clean(title).trim() || 'Untitled';
  const blocks = [{ type: 'title', runs: [{ t: name }] }, ...parseMarkup(content)];
  const doc = await api('POST', DOCS_URL, { title: name }, opts);
  const url = `https://docs.google.com/document/d/${doc.documentId}/edit`;
  const file = { id: doc.documentId, type: 'doc', title: name, url };
  remember(file);
  try {
    await api('POST', `${DOCS_URL}/${doc.documentId}:batchUpdate`, { requests: buildDocRequests(blocks).requests }, opts);
  } catch (e) {
    if (e instanceof GoogleError) e.message += ` (An empty document called "${name}" was still created.)`;
    throw e;
  }
  return file;
}

export async function appendToDoc(file, content, opts = {}) {
  const info = await api('GET', `${DOCS_URL}/${file.id}?fields=body(content(endIndex,paragraph(bullet)))`, null, opts);
  const body = info.body?.content || [];
  const last = body[body.length - 1];
  if (!last?.endIndex) throw new GoogleError('api', "Couldn't read the end of that document.");
  const { requests } = buildDocRequests(parseMarkup(content), {
    base: last.endIndex - 1, newline: true, explicitNormal: true, clearBullets: !!last.paragraph?.bullet,
  });
  await api('POST', `${DOCS_URL}/${file.id}:batchUpdate`, { requests }, opts);
  return file;
}

// ---------- Google Sheets ----------

// One row per line; cells split on | (or tab, or comma). Header row first.
export function parseTable(data) {
  const lines = String(data ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(l));
  const delim = lines.some((l) => l.includes('|')) ? '|' : lines.some((l) => l.includes('\t')) ? '\t' : ',';
  return lines.map((l) => {
    const cells = l.split(delim).map((c) => clean(c).trim().replace(/\*\*/g, ''));
    if (delim === '|') { if (l.startsWith('|')) cells.shift(); if (l.endsWith('|')) cells.pop(); }
    return cells;
  });
}

export async function createSheet(title, data, opts = {}) {
  const rows = parseTable(data);
  if (!rows.length) throw new GoogleError('api', 'There was no data to put in the sheet.');
  const name = clean(title).trim() || 'Untitled';
  const cols = Math.max(...rows.map((r) => r.length));
  const sheetTab = 'Sheet1';
  const sheet = await api('POST', SHEETS_URL, {
    properties: { title: name },
    sheets: [{ properties: { title: sheetTab, gridProperties: { frozenRowCount: 1 } } }],
  }, opts);
  const id = sheet.spreadsheetId;
  const file = {
    id, type: 'sheet', title: name, sheetTitle: sheetTab,
    url: sheet.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${id}/edit`,
  };
  remember(file);
  await api('PUT', `${SHEETS_URL}/${id}/values/${encodeURIComponent(`${sheetTab}!A1`)}?valueInputOption=USER_ENTERED`,
    { range: `${sheetTab}!A1`, majorDimension: 'ROWS', values: rows }, opts);
  const sheetId = sheet.sheets?.[0]?.properties?.sheetId ?? 0;
  try { // looks only - the data is already in, so a failure here is not worth failing the whole request
    await api('POST', `${SHEETS_URL}/${id}:batchUpdate`, {
      requests: [
        { repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: {
            backgroundColor: { red: 0.106, green: 0.227, blue: 0.42 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          } },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        } },
        { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: cols } } },
        { setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, endRowIndex: rows.length, startColumnIndex: 0, endColumnIndex: cols } } } },
      ],
    }, opts);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
  }
  return file;
}

export async function appendToSheet(file, data, opts = {}) {
  const rows = parseTable(data);
  if (!rows.length) throw new GoogleError('api', 'There were no rows to add.');
  await api('POST',
    `${SHEETS_URL}/${file.id}/values/${encodeURIComponent(file.sheetTitle || 'Sheet1')}:append` +
    '?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS',
    { values: rows }, opts);
  return { file, count: rows.length };
}

// ---------- Google Slides ----------

// Same plain format as the PC version: each slide is a title line, "- " bullets and an optional
// "image: <what to show>" line; a blank line starts the next slide.
export function parseSlides(text) {
  const slides = [];
  for (const block of String(text ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
    if (!lines.length) continue;
    const title = clean(lines[0]).replace(/^\s*#{1,3}\s*/, '').replace(/^\s*slide\s*\d+\s*[:.\-]\s*/i, '')
      .replace(/\*\*/g, '').trim();
    const bullets = [];
    let image = '';
    for (const l of lines.slice(1)) {
      const m = /^\s*image\s*:\s*(.+)$/i.exec(l);
      if (m) { image = m[1].trim(); continue; }
      const b = clean(l).replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\*([^*\s][^*]*?)\*/g, '$1').trim();
      if (b) bullets.push(b);
    }
    slides.push({ title: title || 'Untitled', bullets, image });
  }
  return slides.slice(0, 40);
}

// A picture for a slide from Wikimedia Commons. Google's servers fetch the picture themselves
// from this public link, so nothing is downloaded to the phone.
export async function findImage(query, signal) {
  const q = String(query || '').trim();
  if (!q) return null;
  try {
    const r = await fetch(
      'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search' +
      `&gsrsearch=${encodeURIComponent(q)}&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=900`,
      { signal });
    const j = await r.json();
    const pages = Object.values(j.query?.pages || {}).sort((a, b) => a.index - b.index);
    for (const p of pages) {
      const ii = p.imageinfo?.[0];
      if (ii?.thumburl && /\.(jpe?g|png|gif)$/i.test(ii.thumburl) && ii.thumburl.length < 1900) {
        return { url: ii.thumburl, w: ii.thumbwidth || 900, h: ii.thumbheight || 600 };
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
  }
  return null; // a missing picture is not worth failing the whole deck
}

const SLIDES_FIELDS = 'presentationId,pageSize,slides(objectId,pageElements(objectId,shape(placeholder))),' +
  'layouts(objectId,layoutProperties(name),pageElements(shape(placeholder)))';
const TITLE_RGB = { red: 0.106, green: 0.227, blue: 0.42 };
const emu = (n) => ({ magnitude: Math.round(n), unit: 'EMU' });

// layout name (e.g. "TITLE_AND_BODY") -> { id, ph: [{type, index}] }, read from Google's own reply
function readLayouts(pres) {
  const map = new Map();
  for (const l of pres?.layouts || []) {
    const name = l.layoutProperties?.name;
    if (!name || map.has(name)) continue;
    map.set(name, {
      id: l.objectId,
      ph: (l.pageElements || []).map((e) => e.shape?.placeholder).filter(Boolean)
        .map((p) => ({ type: p.type, index: p.index ?? 0 })),
    });
  }
  return map;
}

// Builds the batchUpdate that adds slides. `titleSlide` (optional) is the deck's first, empty slide.
export function buildSlideRequests(slides, {
  layouts, W = 9144000, H = 5143500, nonce: stamp = 'x', images = [], titleSlide = null, deckTitle = '', dateText = '',
} = {}) {
  const req = [];
  const colorTitle = (objectId) => req.push({
    updateTextStyle: {
      objectId, textRange: { type: 'ALL' },
      style: { bold: true, foregroundColor: { opaqueColor: { rgbColor: TITLE_RGB } } }, fields: 'bold,foregroundColor',
    },
  });

  if (titleSlide?.titleId) {
    req.push({ insertText: { objectId: titleSlide.titleId, insertionIndex: 0, text: clean(deckTitle) || 'Untitled' } });
    colorTitle(titleSlide.titleId);
    if (titleSlide.subtitleId && dateText) {
      req.push({ insertText: { objectId: titleSlide.subtitleId, insertionIndex: 0, text: dateText } });
    }
  }

  slides.forEach((s, i) => {
    const img = images[i] || null;
    const wanted = img ? 'TITLE_AND_TWO_COLUMNS' : s.bullets.length ? 'TITLE_AND_BODY' : 'TITLE_ONLY';
    const L = layouts?.get(wanted) || null;
    const ph = L?.ph?.length ? L.ph : [{ type: 'TITLE', index: 0 }, { type: 'BODY', index: 0 }, { type: 'BODY', index: 1 }];
    const titlePh = ph.find((p) => p.type === 'TITLE') || ph.find((p) => p.type === 'CENTERED_TITLE');
    const bodies = ph.filter((p) => p.type === 'BODY').sort((a, b) => a.index - b.index);

    const sid = `m${stamp}s${i}`;
    const ids = { title: `${sid}t`, body: `${sid}b`, right: `${sid}r` };
    const mappings = [];
    if (titlePh) mappings.push({ layoutPlaceholder: { type: titlePh.type, index: titlePh.index }, objectId: ids.title });
    if (s.bullets.length || img) {
      if (bodies[0]) mappings.push({ layoutPlaceholder: { type: 'BODY', index: bodies[0].index }, objectId: ids.body });
      if (img && bodies[1]) mappings.push({ layoutPlaceholder: { type: 'BODY', index: bodies[1].index }, objectId: ids.right });
    }
    req.push({
      createSlide: {
        objectId: sid,
        slideLayoutReference: L ? { layoutId: L.id } : { predefinedLayout: wanted },
        placeholderIdMappings: mappings,
      },
    });
    if (titlePh) {
      req.push({ insertText: { objectId: ids.title, insertionIndex: 0, text: clean(s.title) } });
      colorTitle(ids.title);
    }
    if (s.bullets.length && bodies[0]) {
      req.push({ insertText: { objectId: ids.body, insertionIndex: 0, text: s.bullets.map(clean).join('\n') } });
    }
    if (img && bodies[1]) req.push({ deleteObject: { objectId: ids.right } }); // the picture takes the right-hand column

    if (img) {
      const box = { x: 0.53 * W, y: 0.3 * H, w: 0.42 * W, h: 0.52 * H };
      const k = Math.min(box.w / img.w, box.h / img.h);
      const w = img.w * k;
      const h = img.h * k;
      const x = box.x + (box.w - w) / 2;
      const y = box.y + (box.h - h) / 2;
      req.push({
        createImage: {
          objectId: `${sid}i`, url: img.url,
          elementProperties: {
            pageObjectId: sid, size: { width: emu(w), height: emu(h) },
            transform: { scaleX: 1, scaleY: 1, translateX: Math.round(x), translateY: Math.round(y), unit: 'EMU' },
          },
        },
      });
      req.push({
        createShape: {
          objectId: `${sid}c`, shapeType: 'TEXT_BOX',
          elementProperties: {
            pageObjectId: sid, size: { width: emu(w), height: emu(0.06 * H) },
            transform: { scaleX: 1, scaleY: 1, translateX: Math.round(x), translateY: Math.round(y + h + 0.01 * H), unit: 'EMU' },
          },
        },
      });
      req.push({ insertText: { objectId: `${sid}c`, insertionIndex: 0, text: 'Image: Wikimedia Commons' } });
      req.push({
        updateTextStyle: {
          objectId: `${sid}c`, textRange: { type: 'ALL' },
          style: {
            fontSize: { magnitude: 8, unit: 'PT' },
            foregroundColor: { opaqueColor: { rgbColor: { red: 0.55, green: 0.58, blue: 0.64 } } },
          },
          fields: 'fontSize,foregroundColor',
        },
      });
    }
  });
  return req;
}

const firstSlidePlaceholders = (pres) => {
  const els = pres?.slides?.[0]?.pageElements || [];
  const find = (...types) => els.find((e) => types.includes(e.shape?.placeholder?.type))?.objectId;
  return { pageId: pres?.slides?.[0]?.objectId, titleId: find('CENTERED_TITLE', 'TITLE'), subtitleId: find('SUBTITLE') };
};
const pageSize = (pres) => ({
  W: pres?.pageSize?.width?.magnitude || 9144000, H: pres?.pageSize?.height?.magnitude || 5143500,
});
const newNonce = () => Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 36 ** 2).toString(36);

// Google can't always fetch a picture; if it says so, try again without pictures rather than lose the deck.
async function sendSlides(id, build, hadImages, opts) {
  try {
    await api('POST', `${SLIDES_URL}/${id}:batchUpdate`, { requests: build(true) }, opts);
  } catch (e) {
    if (hadImages && e instanceof GoogleError && e.kind === 'api' && /image|picture|retriev/i.test(e.message)) {
      await api('POST', `${SLIDES_URL}/${id}:batchUpdate`, { requests: build(false) }, opts);
      return;
    }
    throw e;
  }
}

export async function createSlides(title, slidesText, opts = {}) {
  const name = clean(title).trim() || 'Untitled';
  const slides = parseSlides(slidesText);
  const pres = await api('POST', SLIDES_URL, { title: name }, opts);
  const id = pres.presentationId;
  const file = { id, type: 'slides', title: name, url: `https://docs.google.com/presentation/d/${id}/edit` };
  remember(file);

  let info = pres;
  if (!info.slides?.length || !info.layouts?.length) { // some replies are short; ask for the parts we need
    info = await api('GET', `${SLIDES_URL}/${id}?fields=${encodeURIComponent(SLIDES_FIELDS)}`, null, opts);
  }
  const layouts = readLayouts(info);
  const { W, H } = pageSize(info);
  const titleSlide = firstSlidePlaceholders(info);
  const images = await Promise.all(slides.map((s) => (s.image ? findImage(s.image, opts.signal) : null)));
  const dateText = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const stamp = newNonce();
  const build = (withImages) => buildSlideRequests(slides, {
    layouts, W, H, nonce: stamp, images: withImages ? images : [], titleSlide, deckTitle: name, dateText,
  });
  try {
    await sendSlides(id, build, images.some(Boolean), opts);
  } catch (e) {
    if (e instanceof GoogleError) e.message += ` (An empty deck called "${name}" was still created.)`;
    throw e;
  }
  return { ...file, count: slides.length };
}

export async function appendToSlides(file, slidesText, opts = {}) {
  const slides = parseSlides(slidesText);
  if (!slides.length) throw new GoogleError('api', 'There were no slides to add.');
  const info = await api('GET', `${SLIDES_URL}/${file.id}?fields=${encodeURIComponent(SLIDES_FIELDS)}`, null, opts);
  const layouts = readLayouts(info);
  const { W, H } = pageSize(info);
  const images = await Promise.all(slides.map((s) => (s.image ? findImage(s.image, opts.signal) : null)));
  const stamp = newNonce();
  const build = (withImages) => buildSlideRequests(slides, { layouts, W, H, nonce: stamp, images: withImages ? images : [] });
  await sendSlides(file.id, build, images.some(Boolean), opts);
  return { file, count: slides.length };
}
