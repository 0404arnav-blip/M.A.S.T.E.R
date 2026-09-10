"""Master's brain: the model loop, conversation memory, and tools.
No audio here - importable by the Windows client and (later) an HTTP server."""

import sys
import os
import re
import json
import threading
import traceback

import apppath          # sets the working dir (source or packaged .exe)
import requests

import tools

LOG_FILE = apppath.LOG_FILE


def _log_crash(exc_type, exc, tb):
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write("\n--- crash ---\n")
        traceback.print_exception(exc_type, exc, tb, file=f)


sys.excepthook = _log_crash

# under pythonw.exe there is no console, so sys.stdout / sys.stderr are None
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

# ---------- settings ----------
DEBUG = False

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "openai/gpt-oss-20b"
OLLAMA_URL = "http://localhost:11434/api/chat"
OLLAMA_MODEL = "qwen2.5:3b"

HISTORY_FILE = "history.json"
CONFIG_FILE = "config.json"
CONTEXT_TURNS = 12
MAX_TOOL_ROUNDS = 4

SYSTEM_PROMPT = (
    "You are M.A.S.T.E.R - Multi Assistant Software for Technical and Ethical Research - "
    "a personal voice assistant created by Arnav. "
    "Arnav designed and built your tools, memory, voice, and the program that runs you. "
    "Reply in one or two short spoken sentences unless the user asks for detail.\n"
    "If asked your name, say M.A.S.T.E.R and what it stands for. "
    "If asked who built you: Arnav built you. If asked what powers your language ability, "
    "be honest: an open-weight model (OpenAI's gpt-oss via Groq when online, a local Llama "
    "model when offline). Do not claim to have built that model, and do not hide it - "
    "the assistant is Arnav's work, the underlying model is not.\n"
    "Use get_time for the current time or date. "
    "Use web_search for current events, recent facts, prices, or news. "
    "Use get_weather for weather. Use open_website / open_app to open pages or programs. "
    "Use media_control / system_control / set_timer to control the PC. "
    "For create_word_document / create_powerpoint / create_spreadsheet / draft_email, "
    "write the full content yourself first, then pass it to the tool. "
    "Use list_calendar_events / add_calendar_event for the calendar and "
    "set_reminder / set_recurring_reminder / list_reminders for reminders. "
    "Only call get_time first when the user gives a relative DATE like 'tomorrow' or 'next Monday'. "
    "Use remember / recall for long-term facts, find_file / read_file for files, "
    "call / add_contact for phone calls, and add_task / list_tasks for the to-do list. "
    "Do NOT call a tool for normal conversation or things you already know. "
    "When a tool result is given, trust it and answer from it. "
    "When you used web_search for a fact, finish with one short line: 'Source: <site name>'."
)


def log(*a):
    if DEBUG:
        print(*a)


# ---------- pick the backend (config.json is written by setup.py) ----------
API_KEY = ""
_pref = ""
if os.path.exists(CONFIG_FILE):
    with open(CONFIG_FILE, "r", encoding="utf-8-sig") as f:
        _c = json.load(f)
    API_KEY = str(_c.get("groq_api_key", "")).strip()
    if API_KEY == "gsk_your_key_here":
        API_KEY = ""
    _pref = str(_c.get("backend", "")).strip().lower()

if _pref == "ollama":
    backend = "ollama"
elif _pref == "groq" and API_KEY:
    backend = "groq"
else:
    backend = "groq" if API_KEY else "ollama"    # no explicit choice yet


# ---------- model access ----------
def groq_stream(msgs, use_tools, on_text=None):
    payload = {"model": GROQ_MODEL,
               "messages": [{"role": "system", "content": SYSTEM_PROMPT}] + msgs,
               "stream": True}
    if use_tools:
        payload["tools"] = tools.TOOLS
    r = requests.post(GROQ_URL, headers={"Authorization": f"Bearer {API_KEY}"},
                      json=payload, stream=True, timeout=30)
    if r.status_code != 200:
        log(f"(groq {r.status_code}: {r.text[:200]})")
        raise RuntimeError(f"Groq API {r.status_code}")

    content = ""
    tool_calls = []
    for raw in r.iter_lines():
        if not raw:
            continue
        line = raw.decode("utf-8")
        if not line.startswith("data: "):
            continue
        data = line[6:]
        if data == "[DONE]":
            break
        chunk = json.loads(data)
        if not chunk.get("choices"):
            continue
        delta = chunk["choices"][0].get("delta", {})
        piece = delta.get("content")
        if piece:
            content += piece
            if on_text:
                on_text(piece)
            if DEBUG:
                print(piece, end="", flush=True)
        if delta.get("tool_calls"):
            tool_calls.extend(delta["tool_calls"])
    if DEBUG:
        print()

    message = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return message


def ollama_chat(msgs, use_tools, on_text=None):
    payload = {"model": OLLAMA_MODEL,
               "messages": [{"role": "system", "content": SYSTEM_PROMPT}] + msgs,
               "stream": False, "keep_alive": -1}
    if use_tools:
        payload["tools"] = tools.TOOLS
    r = requests.post(OLLAMA_URL, json=payload, timeout=120)
    message = r.json()["message"]
    if on_text and message.get("content") and not message.get("tool_calls"):
        on_text(message["content"])
    return message


def ask_model(msgs, use_tools, on_text=None):
    global backend
    if backend == "groq":
        try:
            return groq_stream(msgs, use_tools, on_text=on_text)
        except (requests.exceptions.RequestException, RuntimeError) as e:
            log(f"(groq unavailable: {e} - trying local model)")
            backend = "ollama"
    return ollama_chat(msgs, use_tools, on_text=on_text)


# ---------- conversation memory ----------
HISTORY_MAX = 600           # keep at most this many messages on disk

if os.path.exists(HISTORY_FILE):
    with open(HISTORY_FILE, "r", encoding="utf-8-sig") as f:
        messages = json.load(f)
    messages = [m for m in messages
                if m.get("role") in ("user", "assistant") and m.get("content")]
    messages = messages[-HISTORY_MAX:]
    log(f"(loaded {len(messages)} past messages)")
else:
    messages = []

_TOOL_STATUS = {
    "web_search": "searching the web", "get_weather": "checking the weather",
    "create_word_document": "writing the document", "create_powerpoint": "building the presentation",
    "create_spreadsheet": "building the spreadsheet", "draft_email": "drafting the email",
    "read_file": "reading the file", "find_file": "looking for the file",
    "list_calendar_events": "checking the calendar", "add_calendar_event": "adding the event",
}


def _recall_context(user_text):
    """Pull relevant saved facts + older conversation the recent window misses."""
    words = set(re.findall(r"[a-z0-9]{3,}", user_text.lower()))
    if not words:
        return ""
    bits = []
    for m in tools._load_json(tools.MEMORY_FILE, []):
        if any(w in m.get("text", "").lower() for w in words):
            bits.append(m["text"])
    older = messages[:-CONTEXT_TURNS] if len(messages) > CONTEXT_TURNS else []
    scored = []
    for m in older:
        c = m.get("content", "")
        hits = sum(1 for w in words if w in c.lower())
        if hits >= 2:
            scored.append((hits, f'({m["role"]}) {c[:220]}'))
    scored.sort(reverse=True)
    bits += [s for _, s in scored[:3]]
    bits = bits[:6]
    return ("Context you already have (use if relevant):\n" + "\n".join(f"- {b}" for b in bits)) if bits else ""


def respond(user_text, on_text=None, on_status=None):
    """One line of user text -> reply. Streams text via on_text(piece); reports
    tool activity via on_status(msg). Injects relevant memory, trims history."""
    ctx = _recall_context(user_text)
    base = ([{"role": "system", "content": ctx}] if ctx else []) + messages[-CONTEXT_TURNS:]
    work = base + [{"role": "user", "content": user_text}]
    answer = ""
    last_tool_result = ""
    rounds = 0
    try:
        while True:
            message = ask_model(work, use_tools=(rounds < MAX_TOOL_ROUNDS), on_text=on_text)
            work.append(message)

            tool_calls = message.get("tool_calls")
            if not tool_calls:
                answer = message.get("content") or ""
                break

            rounds += 1
            for call in tool_calls:
                name = call["function"]["name"]
                raw_args = call["function"].get("arguments")
                args = raw_args if isinstance(raw_args, dict) else json.loads(raw_args or "{}")
                args = {k: v for k, v in args.items() if k and k.isidentifier()}
                if on_status:
                    on_status(_TOOL_STATUS.get(name, f"using {name}") + "…")
                log(f"   [running tool: {name} {args}]")
                func = tools.TOOL_FUNCTIONS.get(name)
                try:
                    result = func(**args) if func else f"Error: no tool named {name}"
                except Exception as te:
                    result = f"That didn't work: {te}"
                last_tool_result = str(result)
                tool_msg = {"role": "tool", "content": str(result)}
                if backend == "groq":
                    tool_msg["tool_call_id"] = call.get("id", "")
                    tool_msg["name"] = name
                else:
                    tool_msg["tool_name"] = name
                work.append(tool_msg)
    except Exception as e:
        log(f"(model error: {e})")
        answer = ("Sorry, I could not reach the assistant service just now. "
                  "Please check your connection or try again in a moment.")

    if not answer.strip():                 # model went quiet after a tool - say what happened
        answer = last_tool_result or "Done."

    messages.append({"role": "user", "content": user_text})
    messages.append({"role": "assistant", "content": answer})
    del messages[:-HISTORY_MAX]
    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump(messages, f, indent=2, ensure_ascii=False)
    return answer


# ---------- background reminders ----------
_reminder_started = False


def _reminder_loop():
    while True:
        try:
            tools._reminder_tick()
        except Exception as e:
            log(f"(reminder tick error: {e})")
        threading.Event().wait(30)


def start_reminder_loop():
    """Start the 30-second reminder checker (call once, after setting tools.announce)."""
    global _reminder_started
    if not _reminder_started:
        threading.Thread(target=_reminder_loop, daemon=True).start()
        _reminder_started = True
