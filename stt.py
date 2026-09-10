"""Speech-to-text via Groq Whisper. Shared by the Windows client and the server."""

import requests

import brain

GROQ_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_STT_MODEL = "whisper-large-v3-turbo"


def transcribe_bytes(data, filename="audio.wav", content_type="audio/wav"):
    """Send audio bytes to Groq Whisper, return the transcript text ('' on failure)."""
    try:
        r = requests.post(
            GROQ_STT_URL,
            headers={"Authorization": f"Bearer {brain.API_KEY}"},
            files={"file": (filename, data, content_type)},
            data={"model": GROQ_STT_MODEL, "response_format": "text", "language": "en"},
            timeout=30,
        )
        return r.text.strip()
    except Exception:
        return ""
