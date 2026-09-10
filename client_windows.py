"""Windows voice client: microphone -> transcribe -> brain.respond -> speak.
Also runs the device-control tools (they act on this PC)."""

import io
import os
import re
import queue
import threading
import tempfile

import numpy as np
import sounddevice as sd
import soundfile as sf
import winsound

import tools
import brain
import tts
import stt

DEBUG = brain.DEBUG
CUES = True

SAMPLE_RATE = 16000
BLOCK = 1600            # 0.1s per block
START_RMS = 2500       # speak louder than this to start recording
SILENCE_RMS = 1200     # below this counts as silence
SILENCE_BLOCKS = 10    # ~1s of silence ends your phrase
MIN_VOICED_BLOCKS = 4  # need ~0.4s of actual sound, else it was just noise
MAX_PHRASE_SEC = 20

STOP_PHRASES = ("goodbye", "shut down", "stop listening", "quit", "exit")

JUNK = {
    "", "you", "thank you", "thanks", "thank you very much", "thanks for watching",
    "thank you for watching", "thank you for watching this video", "bye", "bye bye",
    "see you", "see you next time", "please subscribe", "subscribe", "the", "uh", "um",
    "hmm", "so", "yeah", "okay", "ok", "mm", "mm hmm", "hello hello",
}


def log(*a):
    if DEBUG:
        print(*a)


def normalize(text):
    t = re.sub(r"[^a-z ]", " ", text.lower())
    return re.sub(r"\s+", " ", t).strip()


# ---------- speech out (Piper via tts.py) ----------
def speak(text):
    data = tts.synth_wav(text)
    if not data:
        return
    try:
        tmp = os.path.join(tempfile.gettempdir(), "master_tts.wav")
        with open(tmp, "wb") as f:
            f.write(data)
        winsound.PlaySound(tmp, winsound.SND_FILENAME)
    except Exception as e:
        log(f"(voice error: {e})")


tools.on_timer = speak       # timers announce themselves
tools.announce = speak       # background reminders speak up
brain.start_reminder_loop()


# ---------- microphone (one stream, open for the whole session) ----------
_audio_q = queue.Queue()
mic_error = ""          # set if the mic can't be opened; app still runs (type-only)


def _mic_callback(indata, frames, time_info, status):
    _audio_q.put(bytes(indata))


_mic = None
try:
    _mic = sd.RawInputStream(samplerate=SAMPLE_RATE, blocksize=BLOCK, dtype="int16",
                             channels=1, callback=_mic_callback)
    _mic.start()
except Exception as e:
    mic_error = str(e)
    with open(brain.LOG_FILE, "a", encoding="utf-8") as _f:
        _f.write(f"\nmic unavailable, running type-only: {e}\n")


def _drain():
    try:
        while True:
            _audio_q.get_nowait()
    except queue.Empty:
        pass


def listen(cue=True):
    """Wait for speech, record until silence, return int16 audio (or None if it was just noise)."""
    _drain()
    if CUES and cue:
        winsound.Beep(1200, 120)
        _drain()

    frames = []
    triggered = False
    silent = 0
    voiced = 0
    max_blocks = int(MAX_PHRASE_SEC * SAMPLE_RATE / BLOCK)

    while True:
        try:
            block = _audio_q.get(timeout=1.0)
        except queue.Empty:
            continue

        s = np.frombuffer(block, dtype=np.int16)
        rms = float(np.sqrt(np.mean(s.astype(np.float32) ** 2)))
        if DEBUG and not triggered:
            print(f"  rms={rms:7.0f}", end="\r")

        if not triggered:
            if rms > START_RMS:
                triggered = True
                voiced = 1
                frames.append(s)
        else:
            frames.append(s)
            if rms < SILENCE_RMS:
                silent += 1
                if silent > SILENCE_BLOCKS:
                    break
            else:
                silent = 0
                voiced += 1
            if len(frames) >= max_blocks:
                break

    if voiced < MIN_VOICED_BLOCKS:
        return None
    return np.concatenate(frames) if frames else None


def transcribe(audio):
    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, subtype="PCM_16", format="WAV")
    return stt.transcribe_bytes(buf.getvalue())


def is_stop(text):
    return any(p in normalize(text) for p in STOP_PHRASES)


# ---------- shared handler (voice OR typed input; reply is always spoken) ----------
_lock = threading.Lock()
_ui = {"append": None, "quit": None}       # filled in by run()
_voice_on = threading.Event()              # set = mic is listening; clear = typing only
_voice_on.set()


def _append(s):
    fn = _ui["append"]
    if fn:
        fn(s)


def _clean_for_speech(s):
    """Strip markdown / formatting so Piper doesn't read out '*', '#', etc."""
    s = re.sub(r"[*_`~#>|]", "", s)                 # markdown symbols
    s = re.sub(r"(?m)^[\s\-•]+", "", s)        # leading bullets / dashes on a line
    s = s.replace("&", " and ").replace("...", ".")
    s = re.sub(r"[ \t]+", " ", s)
    return s.strip()


def _sentences(s):
    parts = re.split(r"(?<=[.!?])\s+|\n+", s)
    return [p.strip() for p in parts if p.strip()]


def handle(text):
    """Answer one line of input (spoken or typed). Streams the reply into the
    window as it's generated and speaks each finished sentence as it lands."""
    text = (text or "").strip()
    if len(text) < 1:
        return
    with _lock:
        _append(f"You: {text}\n\n")
        if is_stop(text):
            speak("Goodbye.")
            if _ui["quit"]:
                _ui["quit"]()
            return

        _append("M.A.S.T.E.R: ")
        buf = {"raw": "", "pos": 0}

        def on_status(msg):
            _append(f"\n  … {msg}\n")

        def _say(sentence):
            # show it, but don't read out a "Source: ..." attribution line
            if sentence and not sentence.lower().lstrip("(-• ").startswith("source"):
                speak(sentence)

        def on_text(piece):
            _append(piece)
            buf["raw"] += piece
            clean = _clean_for_speech(buf["raw"])
            while True:                       # speak any whole sentence not yet spoken
                m = re.search(r"[.!?](\s|$)", clean[buf["pos"]:])
                if not m:
                    break
                cut = buf["pos"] + m.end()
                sentence = clean[buf["pos"]:cut].strip()
                buf["pos"] = cut
                _say(sentence)

        answer = brain.respond(text, on_text=on_text, on_status=on_status)

        clean = _clean_for_speech(buf["raw"])
        tail = clean[buf["pos"]:].strip()
        if tail:
            _say(tail)
        if not buf["raw"].strip():            # nothing streamed (tool-only / fallback answer)
            _append(answer)
            for s in _sentences(_clean_for_speech(answer)):
                _say(s)
        _append("\n\n")


def _voice_loop():
    """Microphone -> transcribe -> handle(), forever (paused while voice input is off)."""
    if _mic is None:                    # mic couldn't be opened - stay type-only
        return
    while True:
        _voice_on.wait()               # blocks here whenever voice input is turned off
        audio = listen(cue=True)
        if audio is None:
            continue
        if not _voice_on.is_set():      # turned off mid-capture - drop it
            continue
        text = normalize(transcribe(audio))
        log(f"heard: {text!r}")
        if len(text) < 3 or text in JUNK:
            continue
        if CUES:
            winsound.Beep(600, 100)
        handle(text)


def run():
    """Open a small window. Voice input can be toggled off (type-only);
    Master always answers out loud."""
    import tkinter as tk

    win = tk.Tk()
    win.title("M.A.S.T.E.R")
    win.geometry("460x430")
    win.configure(bg="#0b1020")
    try:
        win.iconbitmap("master.ico")
    except Exception:
        pass
    win.columnconfigure(0, weight=1)
    win.rowconfigure(1, weight=1)

    transcript = tk.Text(win, wrap="word", state="disabled", bg="#10162a", fg="#e8ecf5",
                         font=("Segoe UI", 10), relief="flat", padx=10, pady=8)
    transcript.grid(row=1, column=0, sticky="nsew", padx=8)

    def append(s):
        def _do():
            transcript.configure(state="normal")
            transcript.insert("end", s)
            transcript.see("end")
            transcript.configure(state="disabled")
        win.after(0, _do)

    voice_var = tk.BooleanVar(value=(_mic is not None))

    def toggle_voice():
        if _mic is None:
            voice_var.set(False)
            append("(no microphone available - type only)\n\n")
            return
        if voice_var.get():
            _voice_on.set()
            append("(voice input on)\n\n")
        else:
            _voice_on.clear()
            append("(voice input off - type only)\n\n")

    cb = tk.Checkbutton(win, text="Voice input", variable=voice_var, command=toggle_voice,
                        bg="#0b1020", fg="#e8ecf5", selectcolor="#10162a",
                        activebackground="#0b1020", activeforeground="#e8ecf5")
    if _mic is None:
        cb.configure(state="disabled")
    cb.grid(row=0, column=0, sticky="w", padx=10, pady=(8, 4))

    entry = tk.Entry(win, font=("Segoe UI", 11))
    entry.grid(row=2, column=0, sticky="ew", padx=8, pady=8)
    entry.focus_set()

    def on_type(_evt=None):
        text = entry.get()
        entry.delete(0, "end")
        if text.strip():
            threading.Thread(target=handle, args=(text,), daemon=True).start()

    entry.bind("<Return>", on_type)

    _ui["append"] = append
    _ui["quit"] = lambda: win.after(0, lambda: os._exit(0))
    win.protocol("WM_DELETE_WINDOW", lambda: os._exit(0))

    threading.Thread(target=_voice_loop, daemon=True).start()
    if _mic is None:
        append("M.A.S.T.E.R: Microphone unavailable, so I'm in type-only mode. "
               "Type below and I'll reply out loud.\n"
               "(Fix: Windows Settings > Privacy & security > Microphone > turn on "
               "'Microphone access' and 'Let desktop apps access your microphone', then restart me.)\n\n")
    else:
        append("M.A.S.T.E.R: Ready. Talk any time, or untick 'Voice input' and just type. "
               "I always reply out loud.\n\n")
    win.mainloop()


if __name__ == "__main__":
    run()
