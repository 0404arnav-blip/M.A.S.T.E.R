"""Text-to-speech with Piper. Shared by the Windows client and the server.
Loads the voice once; synth_wav() returns WAV bytes."""

import io
import re
import wave
import threading

import apppath  # noqa: F401  (sets the working dir - import before piper loads a model)
from piper import PiperVoice, SynthesisConfig

# say the acronym as a word, not letter-by-letter
_SPOKEN_FIXES = [
    (re.compile(r"\bM\.?\s*A\.?\s*S\.?\s*T\.?\s*E\.?\s*R\b", re.I), "Master"),
]

PIPER_MODEL = "voices/en_US-kusal-medium.onnx"   # Indian-accented English
VOICE_SPEED = 1.05                               # slightly slower = clearer

_cfg = SynthesisConfig(length_scale=VOICE_SPEED)
_voice = None
_voice_ready = threading.Event()   # loading the model takes a few seconds - don't make
                                    # the whole app wait for it before its window can show
_load_started = threading.Event()


def _load_voice():
    global _voice
    try:
        _voice = PiperVoice.load(PIPER_MODEL)
    except Exception:
        _voice = None
    _voice_ready.set()


def start_loading():
    """Kick off loading the voice model in the background, if it hasn't started
    already (safe to call more than once). Loading is CPU-heavy enough that it's
    worth timing deliberately - call this once the window is already showing,
    not at import time, so it doesn't compete with drawing the window for the CPU/GIL."""
    if not _load_started.is_set():
        _load_started.set()
        threading.Thread(target=_load_voice, daemon=True).start()


def available():
    start_loading()             # in case nothing has kicked it off yet
    _voice_ready.wait()
    return _voice is not None


def synth_wav(text):
    """Return WAV bytes for `text`, or b'' if the voice isn't available.
    Blocks until the voice has finished loading, if it hasn't already -
    in practice that's long done by the time the first reply is ready."""
    if not text:
        return b""
    start_loading()
    _voice_ready.wait()
    if not _voice:
        return b""
    for pat, repl in _SPOKEN_FIXES:
        text = pat.sub(repl, text)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        _voice.synthesize_wav(text, wf, syn_config=_cfg)
    return buf.getvalue()
