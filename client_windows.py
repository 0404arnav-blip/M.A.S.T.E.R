"""Windows voice client: microphone -> transcribe -> brain.respond -> speak.
Also runs the device-control tools (they act on this PC)."""

import io
import os
import re
import time
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
# Playback runs on its own thread so speak() NEVER blocks the assistant.
_speak_q = queue.Queue()
_speak_n = 0
speaking = threading.Event()          # set while M.A.S.T.E.R is talking (mic ignores input then)


def _speaker_worker():
    while True:
        text = _speak_q.get()
        speaking.set()
        try:
            data = tts.synth_wav(text)
            if data:
                global _speak_n
                _speak_n = (_speak_n + 1) % 4          # rotate temp files to avoid races
                tmp = os.path.join(tempfile.gettempdir(), f"master_tts_{_speak_n}.wav")
                with open(tmp, "wb") as f:
                    f.write(data)
                winsound.PlaySound(tmp, winsound.SND_FILENAME)
        except Exception as e:
            log(f"(voice error: {e})")
        finally:
            _speak_q.task_done()
            if _speak_q.empty():
                time.sleep(0.15)                       # tiny grace for a straggling sentence
                if _speak_q.empty():
                    speaking.clear()


threading.Thread(target=_speaker_worker, daemon=True).start()


def speak(text):
    if text and text.strip():
        _speak_q.put(text.strip())


def stop_speaking():
    """Interrupt M.A.S.T.E.R mid-sentence: drop anything still queued to be
    said and silence whatever's playing right now (a barge-in)."""
    try:
        while True:
            _speak_q.get_nowait()
            _speak_q.task_done()
    except queue.Empty:
        pass
    winsound.PlaySound(None, winsound.SND_PURGE)   # stop the sound currently playing
    speaking.clear()


tools.on_timer = speak       # timers announce themselves
tools.announce = speak       # background reminders speak up
brain.start_reminder_loop()


# ---------- microphone (one stream, open for the whole session) ----------
_audio_q = queue.Queue()
mic_error = ""          # set if the mic can't be opened; app still runs (type-only)


def _mic_callback(indata, frames, time_info, status):
    _audio_q.put(bytes(indata))


_mic = None
_mic_ready = threading.Event()   # opening the audio device takes a couple seconds - do it
                                  # in the background so it doesn't delay the window showing up
_mic_start_started = threading.Event()
_on_mic_ready = None             # optional callback, set by run(), to refresh the UI once known


def _open_mic():
    global _mic, mic_error
    try:
        m = sd.RawInputStream(samplerate=SAMPLE_RATE, blocksize=BLOCK, dtype="int16",
                              channels=1, callback=_mic_callback)
        m.start()
        _mic = m
    except Exception as e:
        mic_error = str(e)
        with open(brain.LOG_FILE, "a", encoding="utf-8") as _f:
            _f.write(f"\nmic unavailable, running type-only: {e}\n")
    _mic_ready.set()
    if _on_mic_ready:
        _on_mic_ready()


def start_mic():
    """Kick off opening the microphone in the background, if it hasn't started already
    (safe to call more than once). Called once the window is already showing, not at
    import time, so it doesn't compete with drawing the window for the CPU/GIL."""
    if not _mic_start_started.is_set():
        _mic_start_started.set()
        threading.Thread(target=_open_mic, daemon=True).start()


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

        if speaking.is_set():            # M.A.S.T.E.R started talking - don't record it
            frames, triggered, silent, voiced = [], False, 0, 0
            _drain()
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


_ptt_engaged = threading.Event()   # set while the push-to-talk key is held down


def listen_ptt(released):
    """Record raw mic audio for as long as the push-to-talk key is held (until
    `released` is set). No silence/VAD trimming - the key itself marks start
    and end, which is what makes this safe to use while M.A.S.T.E.R is
    talking: unlike listen(), it doesn't wait to see if you're louder than it."""
    frames = []
    max_blocks = int(MAX_PHRASE_SEC * SAMPLE_RATE / BLOCK)
    while not released.is_set() and len(frames) < max_blocks:
        try:
            block = _audio_q.get(timeout=0.1)
        except queue.Empty:
            continue
        frames.append(np.frombuffer(block, dtype=np.int16))
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
            _speak_q.join()               # let "Goodbye" actually play
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
    start_mic()                         # in case nothing has kicked it off yet
    _mic_ready.wait()                   # wait for the background mic-open attempt to settle
    if _mic is None:                    # mic couldn't be opened - stay type-only
        return
    while True:
        _voice_on.wait()               # blocks here whenever voice input is turned off
        while speaking.is_set() or _ptt_engaged.is_set():
            time.sleep(0.1)             # don't listen while M.A.S.T.E.R is talking, or push-to-talk owns the mic
        time.sleep(0.35)               # let the speaker echo die down
        audio = listen(cue=True)
        if audio is None:
            continue
        if not _voice_on.is_set() or speaking.is_set() or _ptt_engaged.is_set():
            continue   # dropped: toggled off, that was our own voice, or push-to-talk took over
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

    # The mic finishes opening in the background (see _open_mic) - assume it'll work
    # (the common case) so the window doesn't have to wait; _mic_settled() below
    # corrects the checkbox/hint if it turns out there's no mic after all.
    voice_var = tk.BooleanVar(value=True)

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
    cb.grid(row=0, column=0, sticky="w", padx=10, pady=(8, 4))

    ptt_hint = tk.Label(win, text="hold F9 to talk, even while it's speaking", fg="#5c6584",
                        bg="#0b1020", font=("Segoe UI", 8))
    ptt_hint.grid(row=0, column=0, sticky="e", padx=10)

    entry = tk.Entry(win, font=("Segoe UI", 11))
    entry.grid(row=2, column=0, sticky="ew", padx=8, pady=8)
    entry.focus_set()

    def on_type(_evt=None):
        text = entry.get()
        entry.delete(0, "end")
        if text.strip():
            if speaking.is_set():
                stop_speaking()          # typing always interrupts - it's unambiguous, no echo risk
            threading.Thread(target=handle, args=(text,), daemon=True).start()

    entry.bind("<Return>", on_type)

    # ---- push-to-talk: hold F9 to speak over it, even mid-sentence ----
    _ptt_release = {"event": None}

    def on_ptt_press(_evt=None):
        if _mic is None or _ptt_engaged.is_set():
            return
        _ptt_engaged.set()
        if speaking.is_set():
            stop_speaking()              # gated by the key, not always-on - safe to barge in
        _drain()                         # discard whatever the mic already buffered (e.g. its own tail end)
        if CUES:
            winsound.Beep(1200, 120)
        released = threading.Event()
        _ptt_release["event"] = released

        def _record():
            audio = listen_ptt(released)
            _ptt_engaged.clear()
            if audio is None:
                return
            text = normalize(transcribe(audio))
            log(f"ptt heard: {text!r}")
            if len(text) < 3 or text in JUNK:
                return
            if CUES:
                winsound.Beep(600, 100)
            handle(text)

        threading.Thread(target=_record, daemon=True).start()

    def on_ptt_release(_evt=None):
        ev = _ptt_release["event"]
        if ev:
            ev.set()

    win.bind("<KeyPress-F9>", on_ptt_press)
    win.bind("<KeyRelease-F9>", on_ptt_release)

    _ui["append"] = append
    _ui["quit"] = lambda: win.after(0, lambda: os._exit(0))
    win.protocol("WM_DELETE_WINDOW", lambda: os._exit(0))

    # Fix up the checkbox/hint if the background mic-open attempt (started at import
    # time, see _open_mic) turns out to have failed - guarded so it only ever fires once,
    # whether it lands before or after this point.
    _settled = {"done": False}

    def _mic_settled():
        if _settled["done"]:
            return
        _settled["done"] = True
        if _mic is None:
            def _do():
                voice_var.set(False)
                cb.configure(state="disabled")
                ptt_hint.grid_remove()
                append("(microphone unavailable - staying in type-only mode. Fix: Windows "
                       "Settings > Privacy & security > Microphone > turn on 'Microphone "
                       "access' and 'Let desktop apps access your microphone', then restart me.)\n\n")
            win.after(0, _do)

    global _on_mic_ready
    _on_mic_ready = _mic_settled
    if _mic_ready.is_set():          # background open already finished before we got here
        _mic_settled()

    def _start_background_loading():
        # Kicked off a beat after the window is already showing, not before -
        # both of these are CPU-heavy enough to briefly starve the main thread of
        # the GIL, so starting them only once the window has had a chance to paint
        # keeps that contention from delaying the window itself.
        tts.start_loading()
        threading.Thread(target=_voice_loop, daemon=True).start()

    win.after(50, _start_background_loading)
    append("M.A.S.T.E.R: Ready. Talk any time, or untick 'Voice input' and just type. "
           "Hold F9 to talk over me if I'm mid-sentence, or just start typing - either one "
           "interrupts me. I always reply out loud.\n\n")
    win.mainloop()


if __name__ == "__main__":
    run()
