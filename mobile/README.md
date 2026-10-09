# M.A.S.T.E.R on your phone

An installable web app (PWA) version of M.A.S.T.E.R for **Android and iPhone**. It runs
entirely in the phone's browser and talks to [Groq](https://groq.com) directly - there is no
server, no account, and nothing to build. The Windows version in the parent folder is
unchanged and independent.

## What it does

Talk (tap the mic) or type. Replies stream in and are spoken out loud. Tap **Stop**, tap the
mic, or just start typing to interrupt it mid-sentence.

26 tools: time, web search (Wikipedia + news headlines), weather, exact calculator, live
currency conversion, timers, one-off and repeating reminders, long-term memory, to-do list,
learned skills, contacts and call buttons, email drafts (never sent), calendar events, open
a website, copy text.

## What it can't do (compared with the PC version)

Anything that needs the PC: opening apps, volume/media keys, lock/sleep, screenshots,
Word/PowerPoint/Excel creation, reading local files, Outlook, Phone Link.

- Phones don't let a web page open links or start calls on its own, so those tools give you
  a **button to tap** to finish.
- **Reminders and timers only ring while the app is open** (a web app can't run in the
  background). If one comes due while the app was closed, it is announced as "Missed
  reminder" the next time you open it.
- Web search is lighter than the PC version: Wikipedia for facts plus Google News headlines
  (via a free RSS converter that is occasionally unavailable - search falls back to
  Wikipedia alone).
- Voice input needs internet (Groq Whisper) and a browser that can record audio.

## Using it

1. Open the app's address on your phone (see *Hosting* below).
2. Paste a free Groq key from <https://console.groq.com/keys>. It is stored only on the
   phone and sent only to Groq.
3. **Install it:** Android - browser menu, *Install app*. iPhone - Share, *Add to Home Screen*.

## Hosting

The microphone only works on a secure page, so the app has to be served over **https**.
This repository publishes it automatically to GitHub Pages (see
`.github/workflows/pages.yml`) - only the `mobile/` folder is published. One-time setup:
in the repository open *Settings, Pages* and set *Source* to **GitHub Actions**. After the next
push to `main` (or *Actions, Deploy phone app, Run workflow*) the app is at
`https://<your-user>.github.io/<repo>/`. Any other static host works too; the folder is plain files.

To try it on a PC: `python -m http.server 8765 --bind 127.0.0.1` inside this folder, then
open <http://127.0.0.1:8765> (localhost counts as secure).

## Free-tier rate limit

Groq's free tier allows about 8,000 tokens a minute. Every request re-sends the system
prompt and tool list, so this app keeps them small (about a quarter of the PC version's) and
asks the model for low "reasoning effort". If the limit is still hit, a short wait is retried
automatically; a long one shows a message with how long to wait.

## Tests

`tests/test.html` (served over http, as above) runs 96 checks in the browser: the safe
calculator, the stream parser against a real recorded Groq response, the live weather /
currency / search services, reminders, memory and the whole conversation loop with scripted
Groq replies (rate limits, bad key, offline, interruption, runaway tool loops). No API key
is used.

## Privacy and safety

- Your key, chats, memory, tasks and reminders live in the browser's local storage on this
  device only.
- Model and web text is shown as plain text, never as HTML.
- Like the PC version, the model can only call the fixed list of tools in `tools.js`; there
  is no tool that runs code. Text returned by a tool is treated as data, not instructions.

## Running it from a pendrive (Android)

`build_portable.py` packs the whole app into one self-contained `MASTER-phone.html`
(no other files are needed, which is what a phone opening a file from a USB drive requires).
In this build nothing is ever written to the phone's browser storage: chats, memory and
reminders last only until the page is closed.

```bash
python build_portable.py MASTER-phone.html                 # no key: paste yours on the phone each time
python build_portable.py MASTER-phone.html --key-file K    # bake in a key (config.json or a text file)
```

A baked-in key sits in the file in plain text - keep that file on the stick, never commit it.
The easy way to make a whole stick (Windows program + this file + instructions) is
`make_usb.py` in the parent folder. An iPhone cannot open a web app from a USB stick; use the
hosted https version there.
