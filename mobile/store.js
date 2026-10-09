// Tiny key/value store on top of localStorage. Everything M.A.S.T.E.R remembers
// (your Groq key, chat history, memory, tasks, reminders...) lives only on this
// device. Falls back to memory if the browser blocks storage (private mode).

const mem = new Map();
const PREFIX = 'master.';
// The single-file USB build sets this: nothing is written to the phone's browser at all
// (chats, memory and reminders last only until the page is closed).
const MEMORY_ONLY = globalThis.MASTER_PORTABLE === true;

export const store = {
  get(key, fallback) {
    if (MEMORY_ONLY) return mem.has(key) ? mem.get(key) : fallback;
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return mem.has(key) ? mem.get(key) : fallback;
    }
  },
  set(key, value) {
    if (MEMORY_ONLY) { mem.set(key, value); return; }
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      mem.set(key, value);
    }
  },
  remove(key) {
    if (MEMORY_ONLY) { mem.delete(key); return; }
    try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
    mem.delete(key);
  },
};
