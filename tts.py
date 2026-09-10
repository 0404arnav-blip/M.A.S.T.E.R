"""Text-to-speech with Piper. Shared by the Windows client and the server.
Loads the voice once; synth_wav() returns WAV bytes."""

import io
import os
import re
import wave

from piper import PiperVoice, SynthesisConfig

# say the acronym as a word, not letter-by-letter
_SPOKEN_FIXES = [
    (re.compile(r"\bM\.?\s*A\.?\s*S\.?\s*T\.?\s*E\.?\s*R\b", re.I), "Master"),
]

os.chdir(os.path.dirname(os.path.abspath(__file__)))

PIPER_MODEL = "voices/en_US-kusal-medium.onnx"   # Indian-accented English
VOICE_SPEED = 1.05                               # slightly slower = clearer

_cfg = SynthesisConfig(length_scale=VOICE_SPEED)
_voice = None
try:
    _voice = PiperVoice.load(PIPER_MODEL)
except Exception:
    _voice = None


def available():
    return _voice is not None


def synth_wav(text):
    """Return WAV bytes for `text`, or b'' if the voice isn't available."""
    if not _voice or not text:
        return b""
    for pat, repl in _SPOKEN_FIXES:
        text = pat.sub(repl, text)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        _voice.synthesize_wav(text, wf, syn_config=_cfg)
    return buf.getvalue()
