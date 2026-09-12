# M.A.S.T.E.R

**Multi Assistant Software for Technical and Ethical Research**

A local-first, voice-and-text personal assistant for Windows, built by **Arnav**.

M.A.S.T.E.R listens (or reads what you type), thinks with an LLM — a small model
running **locally via [Ollama](https://ollama.com)** by default, or **[Groq](https://groq.com)**
for faster replies — runs real actions on your PC through 30+ tools, remembers things
across sessions, and always answers out loud.

---

## What it can do

**Talk to it or type to it.** A small window shows the conversation; replies stream in
sentence by sentence and are spoken with a Piper neural voice. Voice input can be toggled
off for a type-only session.

### Tools (34)

| Area | Tools |
|---|---|
| **Information** | current time/date, web search (with `Source:` attribution), weather |
| **Documents** | create styled Word docs, PowerPoint decks (with auto-fetched images), Excel sheets |
| **Communication** | draft an email (never sends), phone call via Windows Phone Link, contacts |
| **Calendar** | list upcoming events, add an event (via `.ics`) |
| **Reminders** | one-off and recurring reminders that speak up on time and survive restarts |
| **Memory** | remember / recall / forget long-term facts; older context is retrieved automatically |
| **Files** | find a file, read & summarise text / PDF / Word / Excel |
| **PC control** | open apps & websites, media & volume keys, lock / sleep, clipboard read/write, screenshot, system status (battery / CPU / RAM / disk) |
| **Utilities** | precise calculator, currency conversion (live rates), countdown timer, to-do list |

### Under the hood

- **Streaming replies** — text appears as it's generated; each finished sentence is spoken immediately.
- **Automatic memory** — before every reply it searches your saved facts and older
  conversation for anything relevant and feeds it in, so it recalls things you told it long ago.
- **Graceful fallback** — if the cloud model is rate-limited or offline it switches to the
  local model, and automatically tries the cloud again after a short cooldown instead of
  staying on the slower model for the rest of the session; if both are unreachable it tells
  you instead of going silent.
- **Doesn't hear itself** — the microphone is paused while it's speaking, so it can't pick up
  its own voice through the speakers and reply to itself.
- **History is capped** at 600 messages so it never grows without bound.

---

## Download & run (no Python needed)

1. Grab **`MASTER-windows.zip`** from the [Releases](../../releases) page and unzip it anywhere.
2. **For the free local model:** install [Ollama](https://ollama.com), then run once:
   ```
   ollama pull qwen2.5:3b
   ```
   *(Skip this if you'll use a Groq key instead.)*
3. Double-click **`MASTER.exe`**. On first launch, pick **On this PC** or paste a free
   **[Groq key](https://console.groq.com/keys)** for faster replies.

Settings, history, memory and reminders are all saved inside the app's own folder.

> Windows SmartScreen may warn about an unsigned app — *More info → Run anyway*.

---

## Run from source (for developers)

Requires **Windows 10/11** and **Python 3.10+**.

```bash
git clone https://github.com/0404arnav-blip/M.A.S.T.E.R.git
cd M.A.S.T.E.R

python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt

python -m piper.download_voices --download-dir voices en_US-kusal-medium
copy config.json.example config.json

python Master_code.py
```

A startup window asks **"On this PC (Ollama)"** or **"Use Groq"**, then the assistant window
opens. Talk any time, or type in the box. Say or type **"goodbye"** to stop.
For a windowless launch, make a shortcut to `venv\Scripts\pythonw.exe Master_code.py`.

### Build the .exe

With the venv active:

```bash
build.bat
```

Produces `dist\MASTER\MASTER.exe` (a self-contained folder) and `dist\MASTER-windows.zip`.
Build recipe: [`MASTER.spec`](MASTER.spec).

---

## Usage examples

- "What's the weather in Mumbai?"
- "Make a presentation about the water cycle with images"
- "Write a Word document explaining the French Revolution"
- "Remind me to call the dentist tomorrow at 4 pm"
- "Every weekday at 8 am remind me to take my medicine"
- "Remember that my passport expires in March 2027" … later … "when does my passport expire?"
- "Read my resume and summarise it"
- "Open Spotify" · "volume up" · "lock the screen" · "what's my battery?"
- "Convert 100 dollars to rupees" · "what is 17% of 2400?"
- "Draft an email to alex@example.com about Friday's meeting"

---

## How it's organised

| File | Role |
|---|---|
| `Master_code.py` | entry point — runs the startup chooser, then the assistant |
| `setup.py` | the Ollama / Groq chooser window |
| `brain.py` | the model loop, conversation memory, automatic recall, tool dispatch |
| `client_windows.py` | microphone, voice-activity detection, the window, text/voice input |
| `tools.py` | every tool and its schema |
| `tts.py` | text-to-speech (Piper) |
| `stt.py` | speech-to-text (Groq Whisper) |

---

## Notes & limitations

- **Windows only** — uses `winsound`, Phone Link, Outlook COM, `Get-StartApps`, etc.
- **Microphone** — if Windows privacy settings block mic access, M.A.S.T.E.R still opens in
  type-only mode. Enable it under *Settings → Privacy & security → Microphone*.
- **Local model quirks** — the small local model is occasionally terse or imperfect at
  chaining tools; Groq is more reliable.
- Calendar *reading* needs classic Outlook running.

---

## Credits

- Language models: OpenAI **gpt-oss** (via Groq) / **Llama-family** models (via Ollama) — used under their respective licenses
- Text-to-speech: **[Piper](https://github.com/rhasspy/piper)** by Rhasspy
- Speech-to-text: **Whisper** via the Groq API
- Web & image search: **DuckDuckGo** (`ddgs`)

The assistant software — its tools, memory, voice pipeline, and orchestration — is the
work of Arnav. The underlying language and speech models are not.

## License

[MIT](LICENSE) © 2026 Arnav
