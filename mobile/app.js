// M.A.S.T.E.R on the phone - the screen: chat, voice in (tap the mic), voice out,
// reminders, settings. The thinking lives in brain.js and tools.js.

import {
  respond, transcribe, testKey, getSettings, saveSettings, clearHistory, loadHistory,
  normalize, JUNK, friendlyError,
} from './brain.js';
import { hooks, checkReminders } from './tools.js';

const VERSION = '1.0.0';
const $ = (id) => document.getElementById(id);
const app = $('app'), chat = $('chat'), statusEl = $('status'), input = $('text');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- state ----------
let busy = false;            // a reply is being generated
let abortCtl = null;
let speaking = 0;            // utterances queued/playing
let recording = false;
let transcribing = false;

function refresh() {
  const state = recording ? 'listening' : transcribing ? 'transcribing' : busy ? 'thinking' : speaking > 0 ? 'speaking' : 'ready';
  app.dataset.state = state;
  $('state').textContent = { listening: 'Listening...', transcribing: 'Transcribing...', thinking: 'Thinking...', speaking: 'Speaking...', ready: 'Ready' }[state];
  $('btnStop').hidden = !(busy || speaking > 0);
}

const setStatus = (t) => { statusEl.textContent = t || ''; };
const note = (t) => { setStatus(t); if (t) setTimeout(() => { if (statusEl.textContent === t) setStatus(''); }, 5000); };

// ---------- chat rendering (textContent only - never inject model/web text as HTML) ----------
const scrollDown = () => { chat.scrollTop = chat.scrollHeight; };
const tidy = (s) => s.replace(/\*\*/g, '').replace(/^#+\s*/gm, '');

function bubble(role, text = '') {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  const p = document.createElement('div');
  p.className = 'txt';
  p.textContent = text;
  el.appendChild(p);
  chat.appendChild(el);
  scrollDown();
  return el;
}
function setText(el, text) { el.querySelector('.txt').textContent = text; scrollDown(); }

function addChip(el, a) {
  let bar = el.querySelector('.chips');
  if (!bar) { bar = document.createElement('div'); bar.className = 'chips'; el.appendChild(bar); }
  let node;
  if (a.href) {
    if (!/^(https?:|tel:|mailto:)/i.test(a.href)) return;
    node = document.createElement('a');
    node.href = a.href;
    if (/^https?:/i.test(a.href)) { node.target = '_blank'; node.rel = 'noopener noreferrer'; }
  } else {
    node = document.createElement('button');
    node.type = 'button';
    node.addEventListener('click', a.onClick);
  }
  node.className = 'chip';
  node.textContent = a.label;
  bar.appendChild(node);
  scrollDown();
}

// ---------- speech out ----------
const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
let voices = [];
function loadVoices() { if (synth) voices = synth.getVoices(); }
if (synth) { loadVoices(); synth.addEventListener?.('voiceschanged', () => { loadVoices(); fillVoiceList(); }); }

function pickVoice() {
  const { voiceURI } = getSettings();
  return voices.find((v) => v.voiceURI === voiceURI) ||
    voices.find((v) => /en[-_]IN/i.test(v.lang)) ||
    voices.find((v) => /^en/i.test(v.lang) && v.default) ||
    voices.find((v) => /^en/i.test(v.lang)) || null;
}

let audioUnlocked = false;
function unlockAudio() {          // iPhones only allow speech once a tap has started it
  if (audioUnlocked || !synth) return;
  audioUnlocked = true;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  synth.speak(u);
}

function speakText(text, force = false) {
  if (!synth || !text.trim() || (!force && !getSettings().speak)) return;
  const s = getSettings();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'en-IN'; }
  u.rate = Number(s.rate) || 1;
  const done = () => { speaking = Math.max(0, speaking - 1); refresh(); };
  u.onend = done;
  u.onerror = done;
  speaking++;
  refresh();
  synth.speak(u);
}

function stopSpeaking() {
  if (synth) synth.cancel();
  speaking = 0;
  refresh();
}

function cleanForSpeech(s) {
  return s.replace(/[*_`~#>|]/g, '').replace(/^[\s\-•]+/gm, '').replace(/&/g, ' and ').replace(/\.\.\./g, '.').replace(/[ \t]+/g, ' ').trim();
}

// Speaks each finished sentence as the reply streams in.
function makeSpeaker() {
  let raw = '', pos = 0;
  const say = (s) => { if (s && !/^[(\-•\s]*source/i.test(s)) speakText(s); };
  return {
    feed(piece) {
      raw += piece;
      const clean = cleanForSpeech(raw);
      for (;;) {
        const m = /[.!?](\s|$)/.exec(clean.slice(pos));
        if (!m) break;
        const cut = pos + m.index + m[0].length;
        say(clean.slice(pos, cut).trim());
        pos = cut;
      }
    },
    finish() { const tail = cleanForSpeech(raw).slice(pos).trim(); if (tail) say(tail); pos = Infinity; },
    hasText: () => raw.trim().length > 0,
  };
}

// ---------- sending ----------
async function send(raw) {
  const text = String(raw || '').trim();
  if (!text) return;
  unlockAudio();
  if (busy) { abortCtl.abort(); while (busy) await sleep(25); }   // typing interrupts a reply in progress
  stopSpeaking();
  busy = true;
  abortCtl = new AbortController();
  refresh();
  bubble('user', text);
  const el = bubble('assistant', '');
  el.classList.add('pending');
  hooks.action = (a) => addChip(el, a);
  const speaker = makeSpeaker();
  let shown = '';
  try {
    const res = await respond(text, {
      signal: abortCtl.signal,
      onText(p) { shown += p; setText(el, tidy(shown)); speaker.feed(p); },
      onStatus: setStatus,
    });
    el.classList.remove('pending');
    if (res.error) {
      setText(el, res.text);
      el.classList.add('error');
      speakText(res.text);
    } else {
      if (!speaker.hasText()) { setText(el, tidy(res.text)); speaker.feed(res.text); }
      speaker.finish();
    }
  } catch (e) {
    el.classList.remove('pending');
    if (e.name === 'AbortError') {
      if (!shown.trim() && !el.querySelector('.chips')) el.remove(); else el.classList.add('stopped');
    } else {
      setText(el, friendlyError(e));
      el.classList.add('error');
    }
  } finally {
    busy = false;
    setStatus('');
    refresh();
  }
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = input.value;
  input.value = '';
  send(t);
});

function stopEverything() {
  if (busy && abortCtl) abortCtl.abort();
  stopSpeaking();
}
$('btnStop').addEventListener('click', stopEverything);

// ---------- voice in: tap the mic, talk, it stops when you pause ----------
let rec = null, recStream = null, recCtx = null, vadTimer = null, chunks = [], heard = 0, cancelled = false;

function pickMime() {
  if (!window.MediaRecorder) return '';
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function startRecording() {
  unlockAudio();
  stopEverything();                 // talking over it interrupts it, like holding F9 on the PC
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    note('This browser cannot record audio - please type instead.');
    return;
  }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    note('Microphone is blocked. Allow it for this site in your browser settings, or just type.');
    return;
  }
  const mime = pickMime();
  chunks = []; heard = 0; cancelled = false;
  rec = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = onRecordingStopped;
  rec.start();

  const AC = window.AudioContext || window.webkitAudioContext;
  recCtx = new AC();
  recCtx.resume?.();
  const an = recCtx.createAnalyser();
  an.fftSize = 1024;
  recCtx.createMediaStreamSource(recStream).connect(an);
  const buf = new Uint8Array(an.fftSize);
  let silent = 0;
  const t0 = Date.now();
  vadTimer = setInterval(() => {
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
    const rms = Math.sqrt(sum / buf.length);
    if (rms > 0.045) { heard++; silent = 0; } else if (heard >= 3) { silent++; }
    const elapsed = Date.now() - t0;
    if ((heard >= 3 && silent >= 13) || elapsed > 20000) finishRecording();
    else if (heard < 3 && elapsed > 7000) { cancelRecording(); note("I didn't hear anything."); }
  }, 100);
  recording = true;
  refresh();
}

function finishRecording() { if (rec && rec.state !== 'inactive') rec.stop(); }
function cancelRecording() { cancelled = true; finishRecording(); }

async function onRecordingStopped() {
  clearInterval(vadTimer);
  recStream?.getTracks().forEach((t) => t.stop());
  recCtx?.close?.().catch(() => {});
  recording = false;
  const voiced = heard;
  const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
  rec = null; recStream = null; recCtx = null;
  if (cancelled || voiced < 3 || !blob.size) { refresh(); return; }
  transcribing = true;
  refresh();
  try {
    const text = await transcribe(blob);
    const n = normalize(text);
    if (n.length < 3 || JUNK.has(n)) { note("I didn't catch that."); return; }
    transcribing = false;
    refresh();
    send(text);
  } catch (e) {
    note(friendlyError(e));
  } finally {
    transcribing = false;
    refresh();
  }
}

$('btnMic').addEventListener('click', () => { if (recording) finishRecording(); else startRecording(); });

// ---------- reminders & timers ----------
async function notify(text) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification('M.A.S.T.E.R', { body: text, icon: 'icons/icon-192.png', tag: 'master-reminder' });
    else new Notification('M.A.S.T.E.R', { body: text });
  } catch { /* alerts are best-effort */ }
}

function tickReminders() {
  for (const t of checkReminders()) {
    bubble('system', `⏰ ${t}`);
    speakText(t, true);
    if (document.hidden) notify(t);
    navigator.vibrate?.([200, 100, 200]);
  }
}
setInterval(tickReminders, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tickReminders(); });

// ---------- settings ----------
const sheet = $('settings');

function fillVoiceList() {
  const sel = $('setVoice');
  const cur = getSettings().voiceURI;
  const list = voices.filter((v) => /^en/i.test(v.lang));
  sel.replaceChildren(new Option('Automatic', ''));
  for (const v of list) sel.add(new Option(`${v.name} (${v.lang})`, v.voiceURI));
  sel.value = list.some((v) => v.voiceURI === cur) ? cur : '';
}

function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

function openSettings(firstRun = false) {
  const s = getSettings();
  $('setKey').value = s.key;
  $('setSpeak').checked = s.speak;
  $('setRate').value = s.rate;
  $('rateOut').textContent = `${Number(s.rate).toFixed(2)}x`;
  $('keyMsg').textContent = '';
  $('keyMsg').className = 'note';
  $('welcome').hidden = !firstRun;
  fillVoiceList();
  $('notifyMsg').textContent = !('Notification' in window)
    ? 'Alerts are not supported in this browser.'
    : Notification.permission === 'granted' ? 'Alerts are on.' : Notification.permission === 'denied' ? 'Alerts are blocked in your browser settings.' : '';
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('installHint').textContent = isStandalone() ? 'Installed - running as an app.'
    : ios ? 'To install on iPhone: tap the Share button, then "Add to Home Screen".'
      : 'To install on Android: open the browser menu, then "Install app" (or use the button above).';
  sheet.hidden = false;
}
function closeSettings() { sheet.hidden = true; }

$('btnSettings').addEventListener('click', () => openSettings(false));
$('btnClose').addEventListener('click', closeSettings);
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSettings(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSettings(); });

$('btnSaveKey').addEventListener('click', async () => {
  const key = $('setKey').value.trim();
  const msg = $('keyMsg');
  if (!key) { msg.textContent = 'Paste your Groq key first.'; msg.className = 'note bad'; return; }
  msg.textContent = 'Checking...'; msg.className = 'note';
  $('btnSaveKey').disabled = true;
  const result = await testKey(key);
  $('btnSaveKey').disabled = false;
  if (result === 'ok') {
    saveSettings({ key });
    msg.textContent = 'Key works and is saved.'; msg.className = 'note ok';
    setTimeout(closeSettings, 700);
  } else if (result === 'invalid') {
    msg.textContent = "That key didn't work. Check it and try again."; msg.className = 'note bad';
  } else {
    msg.textContent = "Couldn't reach Groq - check your connection."; msg.className = 'note bad';
  }
});

$('setSpeak').addEventListener('change', (e) => { saveSettings({ speak: e.target.checked }); if (!e.target.checked) stopSpeaking(); });
$('setVoice').addEventListener('change', (e) => saveSettings({ voiceURI: e.target.value }));
$('setRate').addEventListener('input', (e) => {
  saveSettings({ rate: Number(e.target.value) });
  $('rateOut').textContent = `${Number(e.target.value).toFixed(2)}x`;
});
$('btnTestVoice').addEventListener('click', () => { unlockAudio(); stopSpeaking(); speakText('Hello, I am Master. This is how I sound.', true); });

$('btnNotify').addEventListener('click', async () => {
  if (!('Notification' in window)) return;
  const p = await Notification.requestPermission();
  $('notifyMsg').textContent = p === 'granted' ? 'Alerts are on.' : 'Alerts are blocked - allow them in your browser settings.';
});

let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  $('btnInstall').hidden = false;
});
$('btnInstall').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $('btnInstall').hidden = true;
});
window.addEventListener('appinstalled', () => { $('btnInstall').hidden = true; });

$('btnClear').addEventListener('click', () => {
  if (!confirm('Clear the conversation? Saved memory, tasks and reminders are kept.')) return;
  clearHistory();
  chat.replaceChildren();
  bubble('system', 'Conversation cleared.');
  closeSettings();
});

// ---------- start ----------
$('ver').textContent = VERSION;
refresh();

for (const m of loadHistory().slice(-20)) bubble(m.role === 'user' ? 'user' : 'assistant', tidy(m.content));
if (!chat.children.length) {
  bubble('system', 'Ready. Tap the mic and talk, or type. Tap Stop (or just start talking) to interrupt me.');
}

if (globalThis.MASTER_PORTABLE) {
  bubble('system', 'USB mode: nothing is saved on this phone - chats, memory and reminders end when you close this page.');
}
if (!getSettings().key) openSettings(true);

if ('serviceWorker' in navigator && window.isSecureContext && !globalThis.MASTER_PORTABLE) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* works fine without it */ });
}
tickReminders();
