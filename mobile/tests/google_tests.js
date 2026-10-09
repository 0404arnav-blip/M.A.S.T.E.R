// Tests for the Google Docs / Sheets feature. Google itself is replayed with scripted
// responses (no real account or credentials are used), so these check M.A.S.T.E.R's side:
// the sign-in dance, the requests it builds, error handling, and that the secret stays put.

import { store, saveSettings } from '../store.js';
import { respond, systemPrompt } from '../brain.js';
import {
  BASE_TOOLS, ALL_TOOLS, activeTools, TOOL_FUNCTIONS, hooks,
} from '../tools.js';
import {
  parseMarkup, buildDocRequests, parseTable, findFile, listFiles, connect, SETUP_HELP,
  _test as gtest, GoogleError,
} from '../google.js';

const realFetch = window.fetch.bind(window);

// --- a tiny model of a Google Doc, to check the index maths really lands on the right text ---
function applyToFakeDoc(initial, requests) {
  let text = initial; // always ends with the doc's final newline; position 1 = first character
  for (const r of requests) {
    if (r.insertText) {
      const at = (r.insertText.location?.index ?? text.length) - 1;
      text = text.slice(0, at) + r.insertText.text + text.slice(at);
    }
  }
  const end = text.length + 1;
  const paras = [];
  let pos = 1;
  for (const line of text.split('\n').slice(0, -1)) {
    paras.push({ text: line, start: pos, end: pos + line.length + 1, style: 'NORMAL_TEXT', bullet: null, bold: [], italic: [] });
    pos += line.length + 1;
  }
  const problems = [];
  const inDoc = (a, b, what) => { if (!(a >= 1 && a < b && b <= end)) problems.push(`${what} range ${a}-${b} outside the doc (1-${end})`); };
  for (const r of requests) {
    if (r.updateParagraphStyle) {
      const { startIndex: a, endIndex: b } = r.updateParagraphStyle.range;
      inDoc(a, b, 'paragraph style');
      for (const p of paras) if (p.start >= a && p.end <= b) p.style = r.updateParagraphStyle.paragraphStyle.namedStyleType;
    } else if (r.createParagraphBullets) {
      const { startIndex: a, endIndex: b } = r.createParagraphBullets.range;
      inDoc(a, b, 'bullets');
      for (const p of paras) if (p.start >= a && p.end <= b) p.bullet = r.createParagraphBullets.bulletPreset;
    } else if (r.deleteParagraphBullets) {
      const { startIndex: a, endIndex: b } = r.deleteParagraphBullets.range;
      for (const p of paras) if (p.start >= a && p.end <= b) p.bullet = null;
    } else if (r.updateTextStyle) {
      const { startIndex: a, endIndex: b } = r.updateTextStyle.range;
      inDoc(a, b, 'text style');
      const piece = text.slice(a - 1, b - 1);
      if (piece.includes('\n')) problems.push('text style range swallows a line break');
      const st = r.updateTextStyle.textStyle;
      for (const p of paras) if (a >= p.start && b <= p.end) { if (st.bold) p.bold.push(piece); if (st.italic) p.italic.push(piece); }
    }
  }
  return { text, paras, problems, end };
}

export async function googleTests({ head, check, eq, throws }) {
  const form = (b) => (b instanceof URLSearchParams ? Object.fromEntries(b) : b ? JSON.parse(b) : null);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  function mockGoogle(routes) {
    const calls = [];
    window.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (!/googleapis\.com|api\.groq\.com/.test(u)) return realFetch(url, opts);
      const call = { url: u, method: opts.method || 'GET', headers: opts.headers || {}, body: form(opts.body) };
      calls.push(call);
      for (const [match, handler] of routes) {
        if (typeof match === 'string' ? u.includes(match) : match(call)) return handler(call, calls);
      }
      return json({ error: { message: `unmocked ${u}` } }, 500);
    };
    return calls;
  }
  const unmock = () => { window.fetch = realFetch; };

  const sleeps = [];
  const resetGoogle = (configured = true) => {
    for (const k of ['google', 'gfiles', 'settings', 'history']) store.remove(k);
    saveSettings({ key: 'gsk_test_not_a_real_key', ...(configured ? { googleClientId: 'cid.apps.googleusercontent.com', googleClientSecret: 'GOCSPX-test-secret' } : {}) });
    gtest.dropAccessToken();
    sleeps.length = 0;
    gtest.setSleep(async (ms, signal) => {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      sleeps.push(ms);
    });
    const chips = [];
    const statuses = [];
    hooks.action = (a) => chips.push(a);
    hooks.status = (t) => statuses.push(t);
    return { chips, statuses };
  };

  // ===================================================================
  head('google: text -> Docs formatting');
  const md = '# Intro\nHello **world** and *you*.\n\nHi \u{1F600} there\n- one\n- two\n\n1. first\n2. second\n\n## Details\nBye\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  const blocks = parseMarkup(md);
  eq('block types', blocks.map((b) => b.type), ['h1', 'p', 'p', 'bullet', 'bullet', 'number', 'number', 'h2', 'p', 'p', 'p']);
  eq('table rows become plain lines (no markdown separator row)', blocks.slice(-2).map((b) => b.runs.map((r) => r.t).join('')), ['a  |  b', '1  |  2']);
  const created = applyToFakeDoc('\n', buildDocRequests([{ type: 'title', runs: [{ t: 'My Title' }] }, ...blocks]).requests);
  eq('no request lands outside the document', created.problems, []);
  eq('paragraph texts', created.paras.map((p) => p.text), ['My Title', 'Intro', 'Hello world and you.', 'Hi \u{1F600} there', 'one', 'two', 'first', 'second', 'Details', 'Bye', 'a  |  b', '1  |  2']);
  eq('styles land on the right paragraphs (even after an emoji)', created.paras.map((p) => p.style),
    ['TITLE', 'HEADING_1', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT', 'HEADING_2', 'NORMAL_TEXT', 'NORMAL_TEXT', 'NORMAL_TEXT']);
  eq('bullets / numbering on exactly the list lines', created.paras.map((p) => p.bullet ? p.bullet.split('_')[0] : null),
    [null, null, null, null, 'BULLET', 'BULLET', 'NUMBERED', 'NUMBERED', null, null, null, null]);
  eq('bold and italic cover exactly the marked words', [created.paras[2].bold, created.paras[2].italic], [['world'], ['you']]);
  eq('control characters are stripped', buildDocRequests(parseMarkup('a\u0000b\u0007c')).requests[0].insertText.text, 'abc');

  // appending to a doc that currently ends in a bullet
  const existing = 'Notes\nold item\n';
  const base = existing.length; // the position of the doc's final newline
  const appended = applyToFakeDoc(existing, [
    { createParagraphBullets: { range: { startIndex: 7, endIndex: 16 }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } },
    ...buildDocRequests(parseMarkup('## New part\nplain line\n- fresh'), { base, newline: true, explicitNormal: true, clearBullets: true }).requests,
  ].sort((a, b) => (b.insertText ? 1 : 0) - (a.insertText ? 1 : 0)));
  eq('append: nothing outside the doc', appended.problems, []);
  eq('append: text lands after the old text, no stray empty paragraph', appended.paras.map((p) => p.text), ['Notes', 'old item', 'New part', 'plain line', 'fresh']);
  eq('append: heading styled, plain line reset to normal', appended.paras.map((p) => p.style), ['NORMAL_TEXT', 'NORMAL_TEXT', 'HEADING_2', 'NORMAL_TEXT', 'NORMAL_TEXT']);
  eq('append: new plain lines do not join the old list; new bullet does', appended.paras.map((p) => !!p.bullet), [false, true, false, false, true]);

  head('google: spreadsheet text parsing');
  eq('pipe table, leading/trailing pipes, separator row dropped',
    parseTable('| Item | Qty |\n|---|---|\n| Pen | 4 |\n| Book | 12 |'), [['Item', 'Qty'], ['Pen', '4'], ['Book', '12']]);
  eq('comma fallback, bold stripped', parseTable('**Name**, Score\nAsha, 91\nRavi, 78'), [['Name', 'Score'], ['Asha', '91'], ['Ravi', '78']]);
  eq('pipes win over commas inside cells', parseTable('Item | Price\nTea, green | 4.50'), [['Item', 'Price'], ['Tea, green', '4.50']]);
  eq('formulas and blanks pass through', parseTable('a | b | c\n1 | 2 | =SUM(A2:B2)\n\n'), [['a', 'b', 'c'], ['1', '2', '=SUM(A2:B2)']]);

  // ===================================================================
  head('google: not set up -> no network, no extra prompt cost');
  let ui = resetGoogle(false);
  let calls = mockGoogle([]);
  eq('tool explains the setup instead of failing', await TOOL_FUNCTIONS.create_google_doc({ title: 'x', content: 'y' }, {}), SETUP_HELP);
  eq('and makes no network calls', calls.length, 0);
  eq('Google tools are not offered to the model', activeTools().length, BASE_TOOLS.length);
  check('system prompt has no Google line', !/google\.com\/device/.test(systemPrompt()));
  unmock();
  ui = resetGoogle(true);
  eq('once set up, the five Google tools are offered', activeTools().length, ALL_TOOLS.length);
  check('and the prompt explains the approval step', /google\.com\/device/.test(systemPrompt()));

  // ===================================================================
  head('google: first use - sign in, then create a Doc');
  ui = resetGoogle(true);
  let polls = 0;
  calls = mockGoogle([
    ['oauth2.googleapis.com/device/code', () => json({ device_code: 'DEV123', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 })],
    ['oauth2.googleapis.com/token', () => {
      polls++;
      if (polls === 1) return json({ error: 'authorization_pending' }, 428);
      if (polls === 2) return json({ error: 'slow_down' }, 403);
      return json({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 3599 });
    }],
    [(c) => c.url.endsWith('/v1/documents') && c.method === 'POST', () => json({ documentId: 'DOC1' })],
    ['/v1/documents/DOC1:batchUpdate', () => json({})],
  ]);
  const result = await TOOL_FUNCTIONS.create_google_doc({ title: 'Trip plan', content: '# Day 1\n- Fort\n- Lunch' }, {});
  check('result tells the model it worked', /Created the Google Doc "Trip plan"/.test(result), result);
  eq('user is shown the code and where to enter it', [ui.chips[0].href, ui.chips[1].label, ui.statuses[0]],
    ['https://www.google.com/device', '2. Code ABCD-EFGH (tap to copy)', 'Open google.com/device and enter the code ABCD-EFGH']);
  eq('and gets an Open button for the finished doc', [ui.chips.at(-1).label, ui.chips.at(-1).href],
    ['Open in Google Docs', 'https://docs.google.com/document/d/DOC1/edit']);
  eq('status line is cleared afterwards', ui.statuses.at(-1), '');
  eq('waits the interval, and backs off when told to slow down', sleeps, [5000, 5000, 10000]);
  const tokenCalls = calls.filter((c) => c.url.includes('/token'));
  eq('asks only for the narrow drive.file permission', calls[0].body.scope, 'https://www.googleapis.com/auth/drive.file');
  eq('device grant sent correctly', [tokenCalls[0].body.grant_type, tokenCalls[0].body.device_code, tokenCalls[0].body.client_id],
    ['urn:ietf:params:oauth:grant-type:device_code', 'DEV123', 'cid.apps.googleusercontent.com']);
  const docCalls = calls.filter((c) => c.url.includes('/v1/documents'));
  eq('docs calls carry the bearer token', docCalls.every((c) => c.headers.Authorization === 'Bearer AT1'), true);
  eq('doc is created with the title first', docCalls[0].body, { title: 'Trip plan' });
  const fill = docCalls[1].body.requests;
  eq('then filled with one insertText at position 1', [fill[0].insertText.location.index, fill[0].insertText.text], [1, 'Trip plan\nDay 1\nFort\nLunch']);
  eq('refresh token is kept for next time', store.get('google').refresh, 'RT1');
  eq('the doc is remembered', listFiles().map((f) => [f.type, f.title, f.id]), [['doc', 'Trip plan', 'DOC1']]);

  head('google: later use needs no sign-in (cached token, then refresh token)');
  const sheetRoutes = [
    ['oauth2.googleapis.com/token', () => json({ access_token: 'AT2', expires_in: 3599 })],
    [(c) => c.url.endsWith('/v4/spreadsheets') && c.method === 'POST', () => json({ spreadsheetId: 'SH1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/SH1/edit', sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }] })],
    ['/values/Sheet1!A1', () => json({})],
    ['/values/Sheet1:append', () => json({ updates: { updatedRows: 2 } })],
    ['/v4/spreadsheets/SH1:batchUpdate', () => json({})],
    ['/v1/documents/DOC1?fields=', () => json({ body: { content: [{ endIndex: 1 }, { endIndex: 24, paragraph: { bullet: { listId: 'x' } } }] } })],
    ['/v1/documents/DOC1:batchUpdate', () => json({})],
  ];
  unmock();
  calls = mockGoogle(sheetRoutes);
  ui.chips.length = 0;
  const data = 'Item | Cost\nTea | 40\nBus | 25\nTotal | =SUM(B2:B3)';
  const sheetRes = await TOOL_FUNCTIONS.create_google_sheet({ title: 'Expenses', data }, {});
  check('sheet created', /Created the Google Sheet "Expenses"/.test(sheetRes), sheetRes);
  eq('still signed in: no new code, no new token', calls.some((c) => c.url.includes('device/code') || c.url.includes('/token')), false);
  eq('sheet calls used the cached token', calls.every((c) => c.headers.Authorization === 'Bearer AT1'), true);
  calls.length = 0;
  gtest.dropAccessToken();
  await TOOL_FUNCTIONS.create_google_sheet({ title: 'Expenses', data }, {});
  eq('expired token is renewed silently with the refresh token', [calls[0].body.grant_type, calls[0].body.refresh_token], ['refresh_token', 'RT1']);
  const put = calls.find((c) => c.method === 'PUT');
  check('values written with USER_ENTERED so numbers/formulas work', /valueInputOption=USER_ENTERED/.test(put.url) && /Sheet1!A1/.test(decodeURIComponent(put.url)), put.url);
  eq('rows sent as parsed', put.body.values, [['Item', 'Cost'], ['Tea', '40'], ['Bus', '25'], ['Total', '=SUM(B2:B3)']]);
  const fmt = calls.find((c) => c.url.endsWith('SH1:batchUpdate')).body.requests;
  eq('header row styled, columns fitted, filter on', fmt.map((r) => Object.keys(r)[0]), ['repeatCell', 'autoResizeDimensions', 'setBasicFilter']);
  eq('open button points at the sheet', ui.chips.at(-1).href, 'https://docs.google.com/spreadsheets/d/SH1/edit');

  head('google: adding to what it already made');
  gtest.dropAccessToken();
  calls.length = 0; ui.chips.length = 0;
  const addDoc = await TOOL_FUNCTIONS.add_to_google_doc({ which: 'trip', content: '- Dinner\nNote: book early' }, {});
  check('append to the doc found by title words', /Added that to the Google Doc "Trip plan"/.test(addDoc), addDoc);
  const getCall = calls.find((c) => c.method === 'GET');
  check('asks only for the end position of the doc', /fields=body\(content\(endIndex,paragraph\(bullet\)\)\)/.test(getCall.url), getCall.url);
  const appendReq = calls.find((c) => c.url.endsWith('DOC1:batchUpdate')).body.requests;
  eq('inserts at the end (before the final newline), starting a new paragraph', [appendReq[0].insertText.location.index, appendReq[0].insertText.text], [23, '\n- Dinner\nNote: book early'.replace('- ', '')]);
  check('stops the new plain line joining the old bulleted list', appendReq.some((r) => r.deleteParagraphBullets));
  calls.length = 0;
  const addSheet = await TOOL_FUNCTIONS.add_to_google_sheet({ which: 'last', data: 'Snack | 15\nTaxi | 120' }, {});
  check('rows appended', /Added 2 rows to the Google Sheet "Expenses"/.test(addSheet), addSheet);
  check('uses the append endpoint, inserting rows', /values\/Sheet1:append\?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS/.test(calls.at(-1).url), calls.at(-1).url);
  eq('append body', calls.at(-1).body, { values: [['Snack', '15'], ['Taxi', '120']] });
  check('asking for a doc it never made is explained', /haven't made a Google Doc matching 'zebra'/.test(await TOOL_FUNCTIONS.add_to_google_doc({ which: 'zebra', content: 'x' }, {})));
  eq('list shows both', (await TOOL_FUNCTIONS.list_google_files()).split('\n'), ['1. Sheet: Expenses', '2. Doc: Trip plan']);
  eq('find by the number shown in the list', [findFile('2', 'doc')?.title, findFile('1', 'sheet')?.title], ['Trip plan', 'Expenses']);
  eq('a number that points at the wrong kind finds nothing', findFile('1', 'doc'), null);
  eq('find ignores the wrong kind', findFile('expenses', 'doc'), null);
  unmock();

  // ===================================================================
  head('google: a stale token is retried once; a revoked sign-in starts over');
  ui = resetGoogle(true);
  store.set('google', { refresh: 'RT-OLD' });
  let docN = 0;
  calls = mockGoogle([
    ['oauth2.googleapis.com/token', (c) => c.body.grant_type === 'refresh_token' ? json({ access_token: `AT-${++docN}`, expires_in: 3599 }) : json({ error: 'authorization_pending' }, 428)],
    [(c) => c.url.endsWith('/v1/documents') && c.method === 'POST', (c, all) => (all.filter((x) => x.url.endsWith('/v1/documents')).length === 1 ? json({ error: { message: 'Invalid Credentials' } }, 401) : json({ documentId: 'DOC2' }))],
    ['DOC2:batchUpdate', () => json({})],
  ]);
  const retried = await TOOL_FUNCTIONS.create_google_doc({ title: 'Retry', content: 'x' }, {});
  check('401 -> new token -> second attempt works', /Created the Google Doc "Retry"/.test(retried), retried);
  eq('used two different tokens', calls.filter((c) => c.url.endsWith('/v1/documents')).map((c) => c.headers.Authorization), ['Bearer AT-1', 'Bearer AT-2']);
  unmock();

  ui = resetGoogle(true);
  store.set('google', { refresh: 'RT-REVOKED' });
  calls = mockGoogle([
    ['oauth2.googleapis.com/device/code', () => json({ device_code: 'D', user_code: 'WXYZ-1234', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 })],
    ['oauth2.googleapis.com/token', (c) => c.body.grant_type === 'refresh_token' ? json({ error: 'invalid_grant' }, 400) : json({ access_token: 'AT-NEW', refresh_token: 'RT-NEW', expires_in: 3599 })],
    [(c) => c.url.endsWith('/v1/documents') && c.method === 'POST', () => json({ documentId: 'DOC3' })],
    ['DOC3:batchUpdate', () => json({})],
  ]);
  await TOOL_FUNCTIONS.create_google_doc({ title: 'Again', content: 'x' }, {});
  eq('revoked refresh token -> asks you to sign in again, and saves the new one', [ui.chips[1].label.includes('WXYZ-1234'), store.get('google').refresh], [true, 'RT-NEW']);
  unmock();

  // ===================================================================
  head('google: errors are explained, not dumped');
  ui = resetGoogle(true);
  mockGoogle([['device/code', () => json({ error: 'invalid_client' }, 401)]]);
  let msg = await TOOL_FUNCTIONS.create_google_doc({ title: 't', content: 'c' }, {});
  check('wrong Client ID/secret', /Client ID \/ secret/.test(msg) && /TVs and Limited Input devices/.test(msg), msg);
  unmock();

  ui = resetGoogle(true);
  mockGoogle([
    ['device/code', () => json({ device_code: 'D', user_code: 'AAAA-BBBB', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 })],
    ['/token', () => json({ error: 'access_denied' }, 403)],
  ]);
  msg = await TOOL_FUNCTIONS.create_google_doc({ title: 't', content: 'c' }, {});
  check('sign-in refused (e.g. not a test user)', /Test users/.test(msg), msg);
  unmock();

  ui = resetGoogle(true);
  let pend = 0;
  mockGoogle([
    ['device/code', () => json({ device_code: 'D', user_code: 'AAAA-BBBB', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 })],
    ['/token', () => { pend++; return json({ error: 'authorization_pending' }, 428); }],
  ]);
  msg = await TOOL_FUNCTIONS.create_google_doc({ title: 't', content: 'c' }, {});
  check('nobody approves -> gives up politely, not forever', /wasn't approved in time/.test(msg) && pend <= 60, `${msg} (polls: ${pend})`);
  unmock();

  ui = resetGoogle(true);
  store.set('google', { refresh: 'RT' });
  mockGoogle([
    ['/token', () => json({ access_token: 'AT', expires_in: 3599 })],
    [(c) => c.url.endsWith('/v1/documents') && c.method === 'POST', () => json({
      error: { code: 403, message: 'Google Docs API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/docs.googleapis.com/overview?project=123 then retry.', status: 'PERMISSION_DENIED' },
    }, 403)],
  ]);
  msg = await TOOL_FUNCTIONS.create_google_doc({ title: 't', content: 'c' }, {});
  check('API not switched on -> says which, with the link', /not switched on/.test(msg) && /console\.developers\.google\.com\/apis\/api\/docs\.googleapis\.com/.test(msg), msg);
  unmock();

  ui = resetGoogle(true);
  store.set('google', { refresh: 'RT' });
  store.set('gfiles', [{ id: 'GONE', type: 'doc', title: 'Old doc', url: 'u' }]);
  mockGoogle([
    ['/token', () => json({ access_token: 'AT', expires_in: 3599 })],
    ['/v1/documents/GONE', () => json({ error: { message: 'Requested entity was not found.' } }, 404)],
  ]);
  msg = await TOOL_FUNCTIONS.add_to_google_doc({ content: 'x' }, {});
  check('file deleted or not ours -> explains it can only open its own', /didn't create it/.test(msg), msg);
  unmock();

  ui = resetGoogle(true);
  window.fetch = async (url, o) => { if (/googleapis/.test(String(url))) throw new TypeError('Failed to fetch'); return realFetch(url, o); };
  msg = await TOOL_FUNCTIONS.create_google_doc({ title: 't', content: 'c' }, {});
  check('offline', /can't reach Google/.test(msg), msg);
  unmock();

  head('google: stopping mid sign-in, and keeping the secret safe');
  ui = resetGoogle(true);
  const ctl = new AbortController();
  mockGoogle([
    ['device/code', () => json({ device_code: 'D', user_code: 'AAAA-BBBB', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 })],
    ['/token', () => { ctl.abort(); return json({ error: 'authorization_pending' }, 428); }],
  ]);
  let aborted = false;
  try { await TOOL_FUNCTIONS.create_google_doc({ title: 't', content: 'c' }, { signal: ctl.signal }); } catch (e) { aborted = e.name === 'AbortError'; }
  check('pressing Stop ends the wait cleanly', aborted);
  unmock();

  ui = resetGoogle(true);
  calls = mockGoogle([
    ['device/code', () => json({ device_code: 'D', user_code: 'AAAA-BBBB', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 })],
    ['/token', () => json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3599 })],
    [(c) => c.url.endsWith('/v1/documents') && c.method === 'POST', () => json({ documentId: 'D9' })],
    ['D9:batchUpdate', () => json({})],
  ]);
  await TOOL_FUNCTIONS.create_google_doc({ title: 'Secret check', content: 'x' }, {});
  const leaks = calls.filter((c) => JSON.stringify(c.body || '').includes('GOCSPX-test-secret') || JSON.stringify(c.headers).includes('GOCSPX-test-secret'));
  check('client secret only ever goes to Google\'s token endpoint', leaks.every((c) => c.url === 'https://oauth2.googleapis.com/token') && leaks.length >= 1, leaks.map((c) => c.url).join(','));
  check('and no request goes anywhere but Google', calls.every((c) => /^https:\/\/(oauth2|docs|sheets)\.googleapis\.com\//.test(c.url)), calls.map((c) => c.url).join(','));
  unmock();

  head('google: inside the conversation loop');
  ui = resetGoogle(true);
  store.set('google', { refresh: 'RT' });
  const sse = (d, f = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
  let groqCalls = 0;
  const seen = [];
  mockGoogle([
    ['api.groq.com', (c) => {
      groqCalls++;
      seen.push(c.body);
      return new Response(groqCalls === 1
        ? sse({ tool_calls: [{ index: 0, id: 'g1', type: 'function', function: { name: 'create_google_doc', arguments: JSON.stringify({ title: 'Plan', content: '# Goals\n- one' }) } }] }) + sse({}, 'tool_calls') + 'data: [DONE]\n\n'
        : sse({ content: 'Done - tap the button to open it.' }) + sse({}, 'stop') + 'data: [DONE]\n\n', { status: 200 });
    }],
    ['/token', () => json({ access_token: 'AT', expires_in: 3599 })],
    [(c) => c.url.endsWith('/v1/documents') && c.method === 'POST', () => json({ documentId: 'LOOP1' })],
    ['LOOP1:batchUpdate', () => json({})],
  ]);
  const r = await respond('make a Google doc called Plan with goals');
  eq('model asked for the doc, tool ran, model answered', [r.text, groqCalls], ['Done - tap the button to open it.', 2]);
  check('Google tools were offered to the model', seen[0].tools.some((t) => t.function.name === 'create_google_doc'));
  eq('the doc really was created', listFiles().map((f) => f.id), ['LOOP1']);
  unmock();

  // leave things tidy
  gtest.setSleep((ms, signal) => new Promise((res, rej) => { const t = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Aborted', 'AbortError')); }, { once: true }); }));
  for (const k of ['google', 'gfiles', 'settings', 'history']) store.remove(k);
}
