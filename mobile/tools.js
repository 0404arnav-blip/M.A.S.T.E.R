// Everything M.A.S.T.E.R can do on a phone. A fixed list, like the PC version:
// the model can only call a function that exists in TOOL_FUNCTIONS, and there is
// no "run this code" tool anywhere. Tool descriptions are kept short on purpose -
// Groq's free tier allows ~8,000 tokens a minute and every request re-sends them.
//
// Not available on a phone (they need the PC): opening apps, volume/media keys,
// lock/sleep, screenshots, Word/PowerPoint/Excel creation, reading local files,
// Outlook, Phone Link.

import { store } from './store.js';
import {
  isConfigured, createDoc, createSheet, appendToDoc, appendToSheet, findFile, listFiles,
  GoogleError, SETUP_HELP,
} from './google.js';

// app.js sets this so tools can offer a tappable button (phones block pages from
// opening links / starting calls on their own, so the user taps to finish).
export const hooks = { action() {}, status() {} };

const enc = encodeURIComponent;
const S = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

// The free public services these tools use occasionally hiccup (a stray 5xx or a
// dropped connection), so a failed request is retried once before giving up.
async function getJSON(url, ms = 12000, retries = 1) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    return await r.json();
  } catch (e) {
    if (retries > 0 && (!e.status || e.status >= 500)) {
      await new Promise((res) => setTimeout(res, 400));
      return getJSON(url, ms, retries - 1);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const niceDT = (d) => d.toLocaleString('en-IN', {
  weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
});

function parseDT(s) {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseHM(s) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(s || ''));
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return [+m[1], +m[2]];
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const parts = [];
  if (h) parts.push(`${h} hour${h > 1 ? 's' : ''}`);
  if (m) parts.push(`${m} minute${m > 1 ? 's' : ''}`);
  if (s && !h) parts.push(`${s} second${s > 1 ? 's' : ''}`);
  return parts.join(' ') || '0 seconds';
}

// ---------- information ----------

async function get_time() {
  return new Date().toLocaleString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

async function web_search({ query }) {
  query = String(query || '').trim();
  if (!query) return 'What should I search for?';

  const wiki = getJSON(
    'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=search' +
    `&gsrsearch=${enc(query)}&gsrlimit=3&prop=extracts&exintro=1&explaintext=1&exchars=400`
  ).then((j) => Object.values(j.query?.pages || {})
    .sort((a, b) => a.index - b.index)
    .map((p) => `- ${p.title}: ${(p.extract || '').replace(/\s+/g, ' ').trim()}`));

  const feed = `https://news.google.com/rss/search?q=${enc(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const news = getJSON(`https://api.rss2json.com/v1/api.json?rss_url=${enc(feed)}`)
    .then((j) => (j.items || []).slice(0, 5)
      .map((i) => `- ${i.title} (${String(i.pubDate || '').slice(0, 10)})`));

  const [w, n] = await Promise.allSettled([wiki, news]);
  const out = [];
  if (w.status === 'fulfilled' && w.value.length) out.push('Wikipedia:\n' + w.value.join('\n'));
  if (n.status === 'fulfilled' && n.value.length) out.push('Recent news headlines (Google News):\n' + n.value.join('\n'));
  return out.length ? out.join('\n\n') : 'No results found (or the search services are unreachable).';
}

const WMO = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'heavy freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light rain showers', 81: 'rain showers', 82: 'violent rain showers',
  85: 'light snow showers', 86: 'snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'severe thunderstorm with hail',
};

async function get_weather({ place }) {
  const g = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${enc(place)}&count=1`);
  const loc = g.results?.[0];
  if (!loc) return `Couldn't find a place called ${place}.`;
  const w = await getJSON(
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto'
  );
  const c = w.current;
  const where = [loc.name, loc.country].filter(Boolean).join(', ');
  const desc = WMO[c.weather_code] || 'unknown conditions';
  const hi = w.daily?.temperature_2m_max?.[0], lo = w.daily?.temperature_2m_min?.[0];
  return `${where}: ${Math.round(c.temperature_2m)}°C (feels ${Math.round(c.apparent_temperature)}°C), ${desc}, ` +
    `humidity ${c.relative_humidity_2m}%, wind ${Math.round(c.wind_speed_10m)} km/h.` +
    (hi != null ? ` Today ${Math.round(lo)}–${Math.round(hi)}°C.` : '');
}

// A small, safe expression evaluator - numbers, + - * / % ** parentheses and a
// fixed list of math functions. No eval(), nothing else can be reached.
const MATH_FN = {
  sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos,
  atan: Math.atan, log: Math.log10, ln: Math.log, exp: Math.exp, abs: Math.abs, round: Math.round,
  floor: Math.floor, ceil: Math.ceil, min: Math.min, max: Math.max, pow: Math.pow,
};
const MATH_CONST = { pi: Math.PI, e: Math.E };

export function evaluate(raw) {
  const s = String(raw).toLowerCase()
    .replace(/×/g, '*').replace(/÷/g, '/')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/(\d+(?:\.\d+)?)\s*%\s*of\s*/g, '($1/100)*')
    .replace(/\^/g, '**');
  if (s.length > 300) throw new Error('expression too long');
  let i = 0;
  const ws = () => { while (s[i] === ' ') i++; };
  const fail = (msg) => { throw new Error(msg); };

  function expr() {
    let v = term();
    for (;;) {
      ws();
      if (s[i] === '+') { i++; v += term(); }
      else if (s[i] === '-') { i++; v -= term(); }
      else return v;
    }
  }
  function term() {
    let v = unary();
    for (;;) {
      ws();
      if (s[i] === '*' && s[i + 1] !== '*') { i++; v *= unary(); }
      else if (s[i] === '/') { i++; v /= unary(); }
      else if (s[i] === '%') { i++; v %= unary(); }
      else return v;
    }
  }
  function unary() {
    ws();
    if (s[i] === '-') { i++; return -unary(); }
    if (s[i] === '+') { i++; return unary(); }
    return power();
  }
  function power() {
    const base = atom();
    ws();
    if (s[i] === '*' && s[i + 1] === '*') { i += 2; return base ** unary(); }
    return base;
  }
  function atom() {
    ws();
    if (s[i] === '(') {
      i++;
      const v = expr();
      ws();
      if (s[i] !== ')') fail('missing )');
      i++;
      return v;
    }
    const n = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/.exec(s.slice(i));
    if (n) { i += n[0].length; return parseFloat(n[0]); }
    const id = /^[a-z]+/.exec(s.slice(i));
    if (id) {
      const name = id[0];
      i += name.length;
      ws();
      if (s[i] === '(') {
        i++;
        const args = [];
        ws();
        if (s[i] !== ')') {
          for (;;) {
            args.push(expr());
            ws();
            if (s[i] === ',') { i++; continue; }
            break;
          }
        }
        if (s[i] !== ')') fail('missing )');
        i++;
        if (!Object.hasOwn(MATH_FN, name)) fail(`unknown function ${name}`);
        return MATH_FN[name](...args);
      }
      if (Object.hasOwn(MATH_CONST, name)) return MATH_CONST[name];
      fail(`unknown word ${name}`);
    }
    return fail(`unexpected ${s[i] ?? 'end'}`);
  }

  const v = expr();
  ws();
  if (i < s.length) fail(`unexpected ${s[i]}`);
  return v;
}

async function calculate({ expression }) {
  try {
    const v = evaluate(expression);
    if (!Number.isFinite(v)) return `${expression} is undefined (division by zero or too large).`;
    return `${expression} = ${Number(v.toPrecision(12))}`;
  } catch (e) {
    return `Couldn't calculate that: ${e.message}`;
  }
}

async function convert_currency({ amount = 1, from_currency, to_currency }) {
  const from = String(from_currency || '').trim().toUpperCase();
  const to = String(to_currency || '').trim().toUpperCase();
  const amt = Number(amount);
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to) || !(amt >= 0)) {
    return 'Use 3-letter currency codes like USD and INR.';
  }
  if (from === to) return `${amt} ${from} = ${amt} ${to}`;
  try {
    const j = await getJSON(`https://api.frankfurter.dev/v1/latest?amount=${amt}&base=${from}&symbols=${to}`);
    const v = j.rates?.[to];
    if (v == null) return `Couldn't convert ${from} to ${to}.`;
    return `${amt} ${from} = ${Number(v.toFixed(2))} ${to} (rate from ${j.date})`;
  } catch {
    return `Couldn't get a rate for ${from} to ${to}.`;
  }
}

// ---------- phone actions (the user taps a button to finish) ----------

const SITES = {
  youtube: 'https://www.youtube.com', google: 'https://www.google.com', gmail: 'https://mail.google.com',
  maps: 'https://maps.google.com', whatsapp: 'https://web.whatsapp.com', instagram: 'https://www.instagram.com',
  spotify: 'https://open.spotify.com', netflix: 'https://www.netflix.com', github: 'https://github.com',
  wikipedia: 'https://www.wikipedia.org', linkedin: 'https://www.linkedin.com', amazon: 'https://www.amazon.in',
  flipkart: 'https://www.flipkart.com', twitter: 'https://x.com', x: 'https://x.com', reddit: 'https://www.reddit.com',
};

export function resolveSite(target) {
  const t = String(target || '').trim();
  if (!t) return null;
  const key = t.toLowerCase().replace(/\.(com|in)$/, '');
  if (Object.hasOwn(SITES, key)) return SITES[key];
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) return 'https://' + t;
  return 'https://www.google.com/search?q=' + enc(t);
}

async function open_website({ target }) {
  const url = resolveSite(target);
  if (!url) return 'Which site?';
  let host = url;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep url */ }
  hooks.action({ label: `Open ${host}`, href: url });
  return `Ready - tap the button to open ${host}.`;
}

async function draft_email({ to = '', subject = '', body = '' }) {
  const href = `mailto:${to}?subject=${enc(subject)}&body=${enc(body)}`;
  hooks.action({ label: 'Open email draft', href });
  return 'Draft ready. Tap the button to open it in your mail app - I never send anything myself.';
}

async function add_contact({ name, number }) {
  const digits = String(number || '').replace(/[^\d+]/g, '');
  if (!name || digits.length < 5) return 'I need a name and a phone number.';
  const c = store.get('contacts', {});
  c[String(name).trim().toLowerCase()] = digits;
  store.set('contacts', c);
  return `Saved ${name}: ${digits}.`;
}

async function call({ who }) {
  const q = String(who || '').trim();
  const digits = q.replace(/[^\d+]/g, '');
  let number = /^[+\d][\d\s\-()+]{4,}$/.test(q) ? digits : '';
  let label = q;
  if (!number) {
    const c = store.get('contacts', {});
    const key = Object.keys(c).find((k) => k === q.toLowerCase()) ||
      Object.keys(c).find((k) => k.includes(q.toLowerCase()) || q.toLowerCase().includes(k));
    if (!key) return `I don't have a number for ${q}. Say "add contact ${q}" with their number first.`;
    number = c[key];
    label = key;
  }
  hooks.action({ label: `Call ${label}`, href: `tel:${number}` });
  return `Tap the button to call ${label}.`;
}

function icsEscape(t) {
  return String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
const icsStamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;

async function add_calendar_event({ title, start, end, location = '', notes = '' }) {
  const s = parseDT(start);
  if (!title || !s) return 'I need a title and a start time like 2026-10-12 15:00.';
  const e = parseDT(end) || new Date(s.getTime() + 3600e3);
  const now = new Date();
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MASTER//EN', 'BEGIN:VEVENT',
    `UID:${now.getTime()}@master`,
    `DTSTAMP:${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}00Z`,
    `DTSTART:${icsStamp(s)}`, `DTEND:${icsStamp(e)}`,
    `SUMMARY:${icsEscape(title)}`,
    location ? `LOCATION:${icsEscape(location)}` : '',
    notes ? `DESCRIPTION:${icsEscape(notes)}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  hooks.action({
    label: 'Add to calendar',
    onClick() {
      const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'event.ics';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    },
  });
  return `Event ready for ${niceDT(s)}: ${title}. Tap the button to add it to your calendar.`;
}

async function copy_text({ text }) {
  const t = String(text ?? '');
  hooks.action({
    label: 'Copy to clipboard',
    async onClick() { try { await navigator.clipboard.writeText(t); } catch { /* blocked */ } },
  });
  return 'Ready - tap the button to copy it.';
}

// ---------- reminders & timers (fire while the app is open) ----------

const reminders = () => store.get('reminders', []);
const saveReminders = (r) => store.set('reminders', r);
const nextId = (list) => list.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function phoneNotice() {
  const n = store.get('remNotice', 0);
  if (n >= 2) return '';
  store.set('remNotice', n + 1);
  return ' Note: a phone web app can only alert you while M.A.S.T.E.R is open.';
}

function dayMatches(repeat, d) {
  const dow = d.getDay();
  if (repeat === 'daily') return true;
  if (repeat === 'weekdays') return dow >= 1 && dow <= 5;
  if (repeat === 'weekends') return dow === 0 || dow === 6;
  return repeat.split(',').includes(DAYS[dow]);
}

async function set_timer({ seconds, label = '' }) {
  const s = Math.round(Number(seconds));
  if (!(s > 0) || s > 86400) return 'Give me a timer length between 1 second and 24 hours.';
  const list = reminders();
  const what = String(label).trim();
  list.push({
    id: nextId(list), type: 'once', timer: true, atMs: Date.now() + s * 1000,
    text: what ? `Your ${what} timer is up.` : `Your ${fmtDuration(s)} timer is up.`,
  });
  saveReminders(list);
  return `Timer set for ${fmtDuration(s)}.${phoneNotice()}`;
}

async function set_reminder({ text, at }) {
  const dt = parseDT(at);
  if (!dt) return `Couldn't understand the time '${at}'. Use YYYY-MM-DD HH:MM.`;
  if (dt.getTime() < Date.now() - 60000) return 'That time has already passed.';
  const list = reminders();
  list.push({ id: nextId(list), type: 'once', text: String(text), atMs: dt.getTime() });
  saveReminders(list);
  return `Reminder set for ${niceDT(dt)}: ${text}.${phoneNotice()}`;
}

async function set_recurring_reminder({ text, time, repeat = 'daily' }) {
  const hm = parseHM(time);
  if (!hm) return `Couldn't understand the time '${time}'. Use HH:MM.`;
  let rep = String(repeat).toLowerCase().trim();
  if (!['daily', 'weekdays', 'weekends'].includes(rep)) {
    const days = rep.split(/[,\s]+/).map((d) => d.slice(0, 3)).filter((d) => DAYS.includes(d));
    if (!days.length) return "Repeat must be daily, weekdays, weekends, or days like 'mon,wed,fri'.";
    rep = days.join(',');
  }
  const now = new Date();
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hm[0], hm[1]);
  const list = reminders();
  list.push({
    id: nextId(list), type: 'recurring', text: String(text), time: `${pad(hm[0])}:${pad(hm[1])}`,
    repeat: rep, last: now >= due ? ymd(now) : '',
  });
  saveReminders(list);
  return `Repeating reminder set (${rep} at ${pad(hm[0])}:${pad(hm[1])}): ${text}.${phoneNotice()}`;
}

async function list_reminders() {
  const list = reminders();
  if (!list.length) return 'No reminders set.';
  return list.map((r) => (r.type === 'once'
    ? `#${r.id} ${r.text} - ${niceDT(new Date(r.atMs))}`
    : `#${r.id} ${r.text} - ${r.repeat} at ${r.time}`)).join('\n');
}

async function cancel_reminder({ which }) {
  const list = reminders();
  const q = String(which ?? '').toLowerCase().replace('#', '').trim();
  const idx = list.findIndex((r) => String(r.id) === q || r.text.toLowerCase().includes(q));
  if (idx < 0) return `No reminder matching '${which}'.`;
  const [gone] = list.splice(idx, 1);
  saveReminders(list);
  return `Cancelled: ${gone.text}`;
}

// Called every few seconds by the app. Returns the messages that are due now.
export function checkReminders(now = Date.now()) {
  const list = reminders();
  const fired = [];
  const keep = [];
  let changed = false;
  const d = new Date(now);
  const today = ymd(d);
  for (const r of list) {
    if (r.type === 'once') {
      if (r.atMs <= now) {
        changed = true;
        const late = now - r.atMs;
        if (late <= 24 * 3600e3) {
          fired.push(r.timer ? r.text : (late > 120e3 ? `Missed reminder: ${r.text}` : `Reminder: ${r.text}`));
        }
        continue;
      }
      keep.push(r);
    } else {
      keep.push(r);
      if (r.last === today || !dayMatches(r.repeat, d)) continue;
      const [hh, mm] = r.time.split(':').map(Number);
      const due = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm).getTime();
      if (now >= due) {
        r.last = today;
        changed = true;
        if (now - due <= 6 * 3600e3) fired.push(`Reminder: ${r.text}`);
      }
    }
  }
  if (changed) saveReminders(keep);
  return fired;
}

// ---------- memory, tasks, skills ----------

const words = (t) => (String(t).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2);

async function remember({ fact }) {
  const mem = store.get('memory', []);
  mem.push({ text: String(fact), added: ymd(new Date()) });
  store.set('memory', mem);
  return `Noted: ${fact}`;
}

async function recall({ topic = '' }) {
  const mem = store.get('memory', []);
  if (!mem.length) return "I don't have anything remembered yet.";
  const w = words(topic);
  if (!w.length) return mem.map((m) => `- ${m.text}`).join('\n');
  const hits = mem.map((m) => [w.filter((x) => m.text.toLowerCase().includes(x)).length, m.text])
    .filter(([n]) => n > 0).sort((a, b) => b[0] - a[0]);
  return hits.length ? hits.map(([, t]) => `- ${t}`).join('\n') : `Nothing remembered about '${topic}'.`;
}

async function forget({ topic }) {
  const mem = store.get('memory', []);
  const w = words(topic);
  if (!w.length) return 'What should I forget?';
  const keep = mem.filter((m) => !w.every((x) => m.text.toLowerCase().includes(x)));
  const removed = mem.length - keep.length;
  store.set('memory', keep);
  return removed ? `Forgot ${removed} thing${removed > 1 ? 's' : ''} about '${topic}'.` : `Nothing remembered about '${topic}'.`;
}

async function add_task({ text }) {
  const t = store.get('tasks', []);
  t.push({ text: String(text), done: false });
  store.set('tasks', t);
  return `Added to your list: ${text}`;
}

async function list_tasks() {
  const t = store.get('tasks', []).filter((x) => !x.done);
  return t.length ? t.map((x, i) => `${i + 1}. ${x.text}`).join('\n') : 'Your to-do list is empty.';
}

async function complete_task({ task }) {
  const all = store.get('tasks', []);
  const open = all.filter((x) => !x.done);
  const q = String(task).toLowerCase().trim();
  const hit = /^\d+$/.test(q) ? open[+q - 1] : open.find((x) => x.text.toLowerCase().includes(q));
  if (!hit) return `No open task matching '${task}'.`;
  hit.done = true;
  store.set('tasks', all);
  return `Done: ${hit.text}`;
}

async function learn_skill({ name, instruction }) {
  const s = store.get('skills', {});
  s[String(name).trim().toLowerCase()] = String(instruction).trim();
  store.set('skills', s);
  return `Learned the skill '${name}'. Say "do ${name}" any time to run it.`;
}

async function list_skills() {
  const s = store.get('skills', {});
  const e = Object.entries(s);
  return e.length ? e.map(([n, i]) => `- ${n}: ${i}`).join('\n') : 'No skills learned yet.';
}

async function run_skill({ name }) {
  const s = store.get('skills', {});
  const key = String(name).trim().toLowerCase();
  const instr = s[key] ?? Object.entries(s).find(([k]) => k.includes(key) || key.includes(k))?.[1];
  if (!instr) return `No skill called '${name}'. Use list_skills to see what's learned.`;
  return `[Learned skill '${name}'] Steps: ${instr}\nCarry out these steps now using your existing tools, in order, then summarise the result.`;
}

async function forget_skill({ name }) {
  const s = store.get('skills', {});
  const key = String(name).trim().toLowerCase();
  if (!Object.hasOwn(s, key)) return `No skill called '${name}'.`;
  delete s[key];
  store.set('skills', s);
  return `Forgot the skill '${name}'.`;
}

// ---------- Google Docs & Sheets (needs your own Google client - see GOOGLE-SETUP.md) ----------

function googleUi(ctx) {
  return {
    signal: ctx?.signal,
    onCode({ code, url }) { // first use: the user approves M.A.S.T.E.R at google.com/device
      hooks.status(`Open google.com/device and enter the code ${code}`);
      hooks.action({ label: `1. Open ${url.replace(/^https?:\/\//, '')}`, href: url });
      hooks.action({
        label: `2. Code ${code} (tap to copy)`,
        async onClick() { try { await navigator.clipboard.writeText(code); } catch { /* blocked */ } },
      });
    },
  };
}

async function googleRun(ctx, work) {
  if (!isConfigured()) return SETUP_HELP;
  try {
    return await work(googleUi(ctx));
  } catch (e) {
    if (e instanceof GoogleError) return `Couldn't do that: ${e.message}`;
    throw e;
  } finally {
    hooks.status('');
  }
}

const noFile = (type, which) =>
  `I haven't made a Google ${type === 'doc' ? 'Doc' : 'Sheet'}${which && which !== 'last' ? ` matching '${which}'` : ''} yet. ` +
  "I can only add to ones I created - say 'list my Google files' to see them.";

async function create_google_doc({ title, content }, ctx) {
  return googleRun(ctx, async (ui) => {
    const f = await createDoc(title, content, ui);
    hooks.action({ label: 'Open in Google Docs', href: f.url });
    return `Created the Google Doc "${f.title}". Tap the button to open it.`;
  });
}

async function create_google_sheet({ title, data }, ctx) {
  return googleRun(ctx, async (ui) => {
    const f = await createSheet(title, data, ui);
    hooks.action({ label: 'Open in Google Sheets', href: f.url });
    return `Created the Google Sheet "${f.title}". Tap the button to open it.`;
  });
}

async function add_to_google_doc({ which = 'last', content }, ctx) {
  return googleRun(ctx, async (ui) => {
    const f = findFile(which, 'doc');
    if (!f) return noFile('doc', which);
    await appendToDoc(f, content, ui);
    hooks.action({ label: 'Open in Google Docs', href: f.url });
    return `Added that to the Google Doc "${f.title}".`;
  });
}

async function add_to_google_sheet({ which = 'last', data }, ctx) {
  return googleRun(ctx, async (ui) => {
    const f = findFile(which, 'sheet');
    if (!f) return noFile('sheet', which);
    const { count } = await appendToSheet(f, data, ui);
    hooks.action({ label: 'Open in Google Sheets', href: f.url });
    return `Added ${count} row${count === 1 ? '' : 's'} to the Google Sheet "${f.title}".`;
  });
}

async function list_google_files() {
  const l = listFiles();
  if (!l.length) return "I haven't made any Google documents yet.";
  return l.map((f, i) => `${i + 1}. ${f.type === 'doc' ? 'Doc' : 'Sheet'}: ${f.title}`).join('\n');
}

// ---------- registry ----------

export const TOOL_FUNCTIONS = {
  get_time, web_search, get_weather, calculate, convert_currency,
  open_website, draft_email, add_contact, call, add_calendar_event, copy_text,
  set_timer, set_reminder, set_recurring_reminder, list_reminders, cancel_reminder,
  remember, recall, forget, add_task, list_tasks, complete_task,
  learn_skill, list_skills, run_skill, forget_skill,
  create_google_doc, create_google_sheet, add_to_google_doc, add_to_google_sheet, list_google_files,
};

export const BASE_TOOLS = [
  S('get_time', 'Current date and time.'),
  S('web_search', 'Look up facts (Wikipedia) and recent news headlines.', { query: str('search words') }, ['query']),
  S('get_weather', 'Current weather for a place.', { place: str('city or place') }, ['place']),
  S('calculate', 'Exact math. Use for any arithmetic.', { expression: str('e.g. 0.17*2400 or sqrt(81)') }, ['expression']),
  S('convert_currency', 'Convert money at live rates.', { amount: num('amount'), from_currency: str('3-letter code'), to_currency: str('3-letter code') }, ['amount', 'from_currency', 'to_currency']),
  S('open_website', 'Give the user a button to open a site or search.', { target: str('site name, URL or search words') }, ['target']),
  S('draft_email', 'Prepare an email draft (never sends).', { to: str('address'), subject: str('subject'), body: str('full text') }, ['body']),
  S('add_contact', 'Save a phone contact.', { name: str('name'), number: str('phone number') }, ['name', 'number']),
  S('call', 'Give the user a button to call a saved contact or number.', { who: str('contact name or number') }, ['who']),
  S('add_calendar_event', 'Prepare a calendar event.', { title: str('title'), start: str('YYYY-MM-DD HH:MM local'), end: str('YYYY-MM-DD HH:MM, optional'), location: str('optional'), notes: str('optional') }, ['title', 'start']),
  S('copy_text', 'Give the user a button that copies text.', { text: str('text to copy') }, ['text']),
  S('set_timer', 'Countdown timer.', { seconds: num('length in seconds'), label: str('optional name') }, ['seconds']),
  S('set_reminder', 'One-off reminder. Work out the absolute time from the current time.', { text: str('what to remind'), at: str('YYYY-MM-DD HH:MM local') }, ['text', 'at']),
  S('set_recurring_reminder', 'Repeating reminder.', { text: str('what to remind'), time: str('HH:MM 24h'), repeat: str('daily, weekdays, weekends or mon,wed,fri') }, ['text', 'time']),
  S('list_reminders', 'List reminders.'),
  S('cancel_reminder', 'Cancel a reminder.', { which: str('its number or words from it') }, ['which']),
  S('remember', 'Save a long-term fact about the user.', { fact: str('the fact') }, ['fact']),
  S('recall', 'Look up saved facts.', { topic: str('topic, or empty for all') }),
  S('forget', 'Delete saved facts about a topic.', { topic: str('topic') }, ['topic']),
  S('add_task', 'Add to the to-do list.', { text: str('task') }, ['text']),
  S('list_tasks', 'Show the to-do list.'),
  S('complete_task', 'Tick off a task.', { task: str('number or words') }, ['task']),
  S('learn_skill', 'Save a named routine made only of existing tools. ONLY when the user explicitly asks.', { name: str('skill name'), instruction: str('steps in plain words') }, ['name', 'instruction']),
  S('list_skills', 'List learned skills.'),
  S('run_skill', 'Run a learned skill by name.', { name: str('skill name') }, ['name']),
  S('forget_skill', 'Delete a learned skill.', { name: str('skill name') }, ['name']),
];

export const GOOGLE_TOOLS = [
  S('create_google_doc', 'Create a Google Doc in the users Google Drive. Write the full text yourself. "# " headings, "- " bullets, **bold**.', { title: str('document title'), content: str('the full text you wrote') }, ['title', 'content']),
  S('create_google_sheet', 'Create a Google Sheet. Header row first, one row per line, cells separated by |.', { title: str('sheet title'), data: str('the rows you built') }, ['title', 'data']),
  S('add_to_google_doc', 'Add text to a Google Doc you made earlier (default: the latest).', { which: str('title words, or "last"'), content: str('text to add') }, ['content']),
  S('add_to_google_sheet', 'Add rows to a Google Sheet you made earlier (default: the latest).', { which: str('title words, or "last"'), data: str('rows to add, cells separated by |') }, ['data']),
  S('list_google_files', 'List the Google Docs and Sheets you have created.'),
];

export const ALL_TOOLS = [...BASE_TOOLS, ...GOOGLE_TOOLS];

// Google tools are only offered to the model once Google is set up - they cost prompt tokens
// against Groq's free per-minute limit, so people who don't use them don't pay for them.
export const activeTools = () => (isConfigured() ? ALL_TOOLS : BASE_TOOLS);
