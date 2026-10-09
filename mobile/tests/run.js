// Browser test page for the phone version. Open tests/test.html (served over http).
// Real services are used for weather / currency / search; Groq itself is replayed
// from a recorded stream and scripted replies, so no API key is needed or used.

import { store, saveSettings } from '../store.js';
import {
  parseStream, parseDuration, waitFromError, respond, systemPrompt,
  loadHistory, MAX_TOOL_ROUNDS, GroqError,
} from '../brain.js';
import { googleTests } from './google_tests.js';
import { BASE_TOOLS, ALL_TOOLS, activeTools, TOOL_FUNCTIONS, evaluate, resolveSite, checkReminders, hooks } from '../tools.js';
import {
  parseMarkup, buildDocRequests, parseTable, findFile, listFiles, GoogleError, connect as gConnect,
  isConfigured as googleReady, _test as gtest, SETUP_HELP,
} from '../google.js';

const out = document.getElementById('out');
let passed = 0, failed = 0;
const head = (t) => { const d = document.createElement('div'); d.className = 'head'; d.textContent = `-- ${t}`; out.appendChild(d); };
function check(name, cond, detail = '') {
  const d = document.createElement('div');
  d.className = cond ? 'pass' : 'fail';
  d.textContent = `${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `   <- ${detail}`}`;
  out.appendChild(d);
  cond ? passed++ : failed++;
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const throws = async (name, fn) => { try { await fn(); check(name, false, 'did not throw'); } catch { check(name, true); } };

// ---- helpers to fake Groq ----
const realFetch = window.fetch.bind(window);
const sseChunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const textReply = (...parts) => parts.map((p) => sseChunk({ content: p })).join('') + sseChunk({}, 'stop') + 'data: [DONE]\n\n';
const toolReply = (id, name, args) =>
  sseChunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) +
  sseChunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const streamResponse = (text, status = 200) => new Response(text, { status, headers: { 'Content-Type': 'text/event-stream' } });
function mockGroq(handler) {
  const calls = [];
  window.fetch = async (url, opts = {}) => {
    if (String(url).includes('api.groq.com/openai/v1/chat')) {
      const body = JSON.parse(opts.body);
      calls.push(body);
      return handler(calls.length, body, opts);
    }
    return realFetch(url, opts);
  };
  return calls;
}
const unmock = () => { window.fetch = realFetch; };

function reset() {
  for (const k of ['history', 'memory', 'tasks', 'reminders', 'skills', 'contacts', 'settings', 'remNotice']) store.remove(k);
  saveSettings({ key: 'gsk_test_not_a_real_key' });
  hooks.action = () => {};
}

// =========================================================================
head('calculator (safe parser)');
for (const [e, want] of [
  ['2+3*4', 14], ['(2+3)*4', 20], ['2**10', 1024], ['2^3^2', 512], ['17% of 2400', 408], ['0.17*2400', 408],
  ['sqrt(81)', 9], ['10 % 4', 2], ['-3 + 5', 2], ['1,234 + 1', 1235], ['max(3, 9, 4)', 9], ['pi*2', Math.PI * 2], ['100/8', 12.5],
]) eq(`${e} = ${want}`, Number(evaluate(e).toPrecision(12)), Number(want.toPrecision(12)));
for (const bad of ['constructor(1)', '__proto__', 'alert(1)', 'process.exit()', '2+', '((1)', 'a'.repeat(400), 'toString()', '1; 2']) {
  await throws(`rejects: ${bad.slice(0, 30)}`, () => evaluate(bad));
}
eq('divide by zero reported, not crashed', (await TOOL_FUNCTIONS.calculate({ expression: '1/0' })).includes('undefined'), true);

// =========================================================================
head('rate-limit message parsing');
eq('7.5s', waitFromError('Rate limit reached. Please try again in 7.5s. Need more tokens?'), 8);
eq('1m12.5s', waitFromError('Please try again in 1m12.5s.'), 73);
eq('2h3m', parseDuration('2h3m'), 7380);
eq('250ms', parseDuration('250ms'), 0.25);
eq('no hint -> 0', waitFromError('some other error'), 0);

// =========================================================================
head('stream parser');
const fixture = await (await realFetch('./fixtures/groq_tool_call.sse')).text();
let streamed = '';
const m1 = await parseStream(streamResponse(fixture), (p) => { streamed += p; });
eq('real Groq stream: one tool call', m1.tool_calls?.length, 1);
eq('real Groq stream: name', m1.tool_calls?.[0].function.name, 'get_weather');
eq('real Groq stream: args', JSON.parse(m1.tool_calls[0].function.arguments), { place: 'Pune' });
eq('real Groq stream: reasoning text not shown', streamed, '');
const frag =
  sseChunk({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'calculate', arguments: '{"expres' } }] }) +
  sseChunk({ tool_calls: [{ index: 0, function: { arguments: 'sion":"2+' } }] }) +
  sseChunk({ tool_calls: [{ index: 0, function: { arguments: '2"}' } }, { index: 1, id: 'b', type: 'function', function: { name: 'get_time', arguments: '{}' } }] }) +
  'data: [DONE]\n\n';
const m2 = await parseStream(streamResponse(frag));
eq('fragmented args are joined', JSON.parse(m2.tool_calls[0].function.arguments), { expression: '2+2' });
eq('two parallel calls kept apart', m2.tool_calls.map((c) => c.function.name), ['calculate', 'get_time']);
const m3 = await parseStream(streamResponse(textReply('Hel', 'lo ', 'there.')));
eq('plain text assembled', m3.content, 'Hello there.');
// stream split mid-line across network reads
const whole = textReply('split test.');
const split = new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); c.enqueue(e.encode(whole.slice(0, 37))); c.enqueue(e.encode(whole.slice(37))); c.close(); } }));
eq('line split across reads', (await parseStream(split)).content, 'split test.');

// =========================================================================
head('prompt size (Groq free tier: 8,000 tokens/minute)');
const promptChars = systemPrompt().length + JSON.stringify(BASE_TOOLS).length;
check(`system prompt + ${BASE_TOOLS.length} tools = ${promptChars} chars (PC version: 12,832 chars ~ 1,971 tokens)`, promptChars < 9000, `${promptChars}`);
check('every tool has a function', ALL_TOOLS.every((t) => Object.hasOwn(TOOL_FUNCTIONS, t.function.name)));
check('every function has a schema', Object.keys(TOOL_FUNCTIONS).every((n) => ALL_TOOLS.some((t) => t.function.name === n)));
check('no code-execution tool', !ALL_TOOLS.some((t) => /exec|eval|shell|run_code|script/i.test(t.function.name)));

// =========================================================================
head('site resolver');
eq('youtube', resolveSite('YouTube'), 'https://www.youtube.com');
eq('domain', resolveSite('example.org/page'), 'https://example.org/page');
eq('words -> search', resolveSite('best pizza near me'), 'https://www.google.com/search?q=best%20pizza%20near%20me');
eq('javascript: never opened', resolveSite('javascript:alert(1)').startsWith('https://www.google.com/search'), true);

// =========================================================================
head('live services (needs internet)');
const weather = await TOOL_FUNCTIONS.get_weather({ place: 'Pune' });
check('weather: Pune', /Pune/.test(weather) && /°C/.test(weather), weather);
const fx = await TOOL_FUNCTIONS.convert_currency({ amount: 100, from_currency: 'USD', to_currency: 'INR' });
check('currency: 100 USD -> INR', /100 USD = [\d.]+ INR/.test(fx), fx);
const search = await TOOL_FUNCTIONS.web_search({ query: 'Chandrayaan-3' });
check('search: Wikipedia part', /Wikipedia:/.test(search), search.slice(0, 120));
check('search: news part', /headlines/.test(search), search.slice(0, 160));
check('weather: unknown place handled', /Couldn't find/.test(await TOOL_FUNCTIONS.get_weather({ place: 'Qzxwvyu Nowhereville' })));

// =========================================================================
head('reminders, timers, memory, tasks, skills');
reset();
eq('bad time rejected', (await TOOL_FUNCTIONS.set_reminder({ text: 'x', at: 'tomorrow' })).includes("Couldn't understand"), true);
eq('past time rejected', (await TOOL_FUNCTIONS.set_reminder({ text: 'x', at: '2020-01-01 10:00' })).includes('already passed'), true);
const p2 = (n) => String(n).padStart(2, '0');
const futureAt = (minutes) => {
  const d = new Date(Date.now() + minutes * 60_000);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
check('set_reminder ok', (await TOOL_FUNCTIONS.set_reminder({ text: 'call the dentist', at: futureAt(5) })).startsWith('Reminder set'));
await TOOL_FUNCTIONS.set_timer({ seconds: 30, label: 'tea' });
eq('nothing due yet', checkReminders(Date.now()), []);
eq('timer fires with its label', checkReminders(Date.now() + 40_000), ['Your tea timer is up.']);
const dentist = store.get('reminders').find((x) => x.text === 'call the dentist');
eq('reminder fires once due', checkReminders(dentist.atMs + 30_000), ['Reminder: call the dentist']);
eq('and never again', checkReminders(dentist.atMs + 400_000), []);
await TOOL_FUNCTIONS.set_reminder({ text: 'late one', at: futureAt(5) });
const late = store.get('reminders').find((x) => x.text === 'late one');
eq('very late reminder is called "missed"', checkReminders(late.atMs + 3 * 3600e3), ['Missed reminder: late one']);
// recurring: pretend it is 08:05 on a Monday
const mon = new Date(2026, 9, 12, 8, 5).getTime();
reset();
await TOOL_FUNCTIONS.set_recurring_reminder({ text: 'medicine', time: '08:00', repeat: 'weekdays' });
store.set('reminders', store.get('reminders').map((r) => ({ ...r, last: '' })));
eq('weekday reminder fires Monday 08:05', checkReminders(mon), ['Reminder: medicine']);
eq('not twice the same day', checkReminders(mon + 60_000), []);
store.set('reminders', store.get('reminders').map((r) => ({ ...r, last: '' })));
eq('does not fire on Saturday', checkReminders(new Date(2026, 9, 17, 8, 5).getTime()), []);
eq('list_reminders', (await TOOL_FUNCTIONS.list_reminders()).includes('weekdays at 08:00'), true);
eq('cancel_reminder', (await TOOL_FUNCTIONS.cancel_reminder({ which: 'medicine' })).startsWith('Cancelled'), true);

reset();
await TOOL_FUNCTIONS.remember({ fact: 'my passport expires in March 2027' });
eq('recall finds it', (await TOOL_FUNCTIONS.recall({ topic: 'passport' })).includes('March 2027'), true);
eq('forget removes it', (await TOOL_FUNCTIONS.forget({ topic: 'passport' })).startsWith('Forgot 1'), true);
eq('and it is gone', /Nothing remembered|don't have anything/.test(await TOOL_FUNCTIONS.recall({ topic: 'passport' })), true);
await TOOL_FUNCTIONS.add_task({ text: 'buy groceries' });
await TOOL_FUNCTIONS.add_task({ text: 'book train tickets' });
eq('task list', (await TOOL_FUNCTIONS.list_tasks()), '1. buy groceries\n2. book train tickets');
await TOOL_FUNCTIONS.complete_task({ task: '1' });
eq('completing removes it', (await TOOL_FUNCTIONS.list_tasks()), '1. book train tickets');
await TOOL_FUNCTIONS.learn_skill({ name: 'Morning Briefing', instruction: 'tell the time and the weather' });
eq('skill runs by fuzzy name', (await TOOL_FUNCTIONS.run_skill({ name: 'briefing' })).includes('tell the time and the weather'), true);
eq('forget skill', (await TOOL_FUNCTIONS.forget_skill({ name: 'morning briefing' })).startsWith('Forgot'), true);
let chip = null;
hooks.action = (a) => { chip = a; };
await TOOL_FUNCTIONS.add_contact({ name: 'Alex', number: '+91 98765 43210' });
await TOOL_FUNCTIONS.call({ who: 'alex' });
eq('call gives a tel: button', chip?.href, 'tel:+919876543210');
await TOOL_FUNCTIONS.draft_email({ to: 'a@b.com', subject: 'Hi there', body: 'Line one\nLine two' });
eq('email gives a mailto: button, never sends', chip?.href, 'mailto:a@b.com?subject=Hi%20there&body=Line%20one%0ALine%20two');

// =========================================================================
head('conversation loop (Groq replayed)');
reset();
let calls = mockGroq(() => streamResponse(textReply('Hello ', 'Arnav.')));
let live = '';
let r = await respond('hi there', { onText: (p) => { live += p; } });
eq('plain reply returned', r.text, 'Hello Arnav.');
eq('and streamed live', live, 'Hello Arnav.');
eq('reasoning_effort is low', calls[0].reasoning_effort, 'low');
eq('tools offered on round 1', Array.isArray(calls[0].tools) && calls[0].tools.length === BASE_TOOLS.length, true);
check('system prompt carries the current time', /Current date and time:/.test(calls[0].messages[0].content));
eq('history saved', loadHistory().map((m) => m.role), ['user', 'assistant']);
unmock();

reset();
calls = mockGroq((n) => streamResponse(n === 1
  ? toolReply('call_1', 'calculate', { expression: '17*23' })
  : textReply('It is 391.')));
const statuses = [];
r = await respond('what is 17 times 23', { onStatus: (s) => statuses.push(s) });
eq('tool result used in the answer', r.text, 'It is 391.');
eq('two model calls', calls.length, 2);
const toolMsg = calls[1].messages.find((m) => m.role === 'tool');
eq('tool result fed back correctly', [toolMsg?.tool_call_id, toolMsg?.name, toolMsg?.content], ['call_1', 'calculate', '17*23 = 391']);
check('assistant tool_calls message present before tool result', calls[1].messages.some((m) => m.role === 'assistant' && m.tool_calls?.length));
eq('status shown', statuses, ['using calculate...']);
unmock();

reset();
calls = mockGroq(() => streamResponse(toolReply('c', 'get_time', {})));
r = await respond('keep calling tools forever');
eq(`runaway tool loop capped at ${MAX_TOOL_ROUNDS} rounds + 1 forced answer`, calls.length, MAX_TOOL_ROUNDS + 1);
eq('last call offers no tools', calls[calls.length - 1].tools, undefined);
unmock();

reset();
calls = mockGroq(() => streamResponse(toolReply('c', 'rm_rf_everything', { path: '/' })));
let seen = null;
calls = mockGroq((n, body) => {
  if (n === 2) seen = body.messages.find((m) => m.role === 'tool')?.content;
  return streamResponse(n === 1 ? toolReply('c', 'rm_rf_everything', {}) : textReply('I cannot do that.'));
});
await respond('delete everything');
eq('unknown tool is refused, nothing runs', seen, 'Error: no tool named rm_rf_everything');
unmock();

reset();
calls = mockGroq((n) => (n === 1
  ? streamResponse(JSON.stringify({ error: { message: 'Rate limit reached. Please try again in 1s.' } }), 429)
  : streamResponse(textReply('Back again.'))));
const t0 = performance.now();
const retried = [];
r = await respond('hello', { onStatus: (s) => retried.push(s) });
eq('short rate limit: waits and retries by itself', [r.text, calls.length], ['Back again.', 2]);
check('it actually waited ~1s', performance.now() - t0 >= 1000, `${Math.round(performance.now() - t0)}ms`);
check('user is told', retried.some((s) => /trying again in 1s/.test(s)), JSON.stringify(retried));
unmock();

reset();
calls = mockGroq(() => streamResponse(JSON.stringify({ error: { message: 'Please try again in 2m30s.' } }), 429));
r = await respond('hello');
check('long rate limit: friendly message, no endless waiting', r.error && /about 3 minutes/.test(r.text), r.text);
eq('and not saved to history', loadHistory().length, 0);
unmock();

reset();
calls = mockGroq(() => streamResponse('{"error":{"message":"Invalid API Key"}}', 401));
r = await respond('hello');
check('bad key: tells the user to check settings', r.error && /key/i.test(r.text), r.text);
unmock();

reset();
window.fetch = async (url, opts = {}) => {
  if (String(url).includes('api.groq.com')) throw new TypeError('Failed to fetch');
  return realFetch(url, opts);
};
r = await respond('hello');
check('offline: clear message', r.error && /internet/i.test(r.text), r.text);
unmock();

reset();
saveSettings({ key: '' });
r = await respond('hello');
check('no key set: asks for the key instead of crashing', r.error && /key/i.test(r.text), r.text);

reset();
const ctl = new AbortController();
window.fetch = (url, opts = {}) => {
  if (String(url).includes('api.groq.com')) {
    return new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))));
  }
  return realFetch(url, opts);
};
const pending = respond('this will be interrupted', { signal: ctl.signal });
setTimeout(() => ctl.abort(), 50);
let abortedOk = false;
try { await pending; } catch (e) { abortedOk = e.name === 'AbortError'; }
check('interrupting a reply aborts cleanly', abortedOk);
eq('and an interrupted reply is not saved', loadHistory().length, 0);
unmock();

reset();
await TOOL_FUNCTIONS.remember({ fact: 'my favourite colour is teal' });
calls = mockGroq(() => streamResponse(textReply('Teal.')));
await respond('what is my favourite colour');
check('saved memory is fed to the model automatically', calls[0].messages.some((m) => m.role === 'system' && /teal/.test(m.content)));
unmock();

await googleTests({ head, check, eq, throws });

// ---- done ----
reset();
store.remove('settings');
const s = document.getElementById('summary');
s.textContent = failed ? `${failed} FAILED, ${passed} passed` : `ALL ${passed} PASSED`;
s.className = failed ? 'fail' : 'pass';
window.__testDone = { passed, failed };
