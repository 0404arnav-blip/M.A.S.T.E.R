import sys, time, json, os, queue, tempfile, wave
import numpy as np
import sounddevice as sd
import soundfile as sf
import requests

os.chdir(os.path.dirname(os.path.abspath(__file__)))

print("=" * 50)
print("MASTER DIAGNOSTIC")
print("=" * 50)

# 1. other instances holding the mic?
import subprocess
out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq pythonw.exe"], capture_output=True, text=True).stdout
print("\n[1] pythonw.exe running?:", "YES - kill it first!" if "pythonw" in out.lower() else "no (good)")

# 2. mic devices
print("\n[2] default input device:")
try:
    print("   ", sd.query_devices(kind="input")["name"])
except Exception as e:
    print("    ERROR:", e)

# 3. live mic levels for 6 seconds
print("\n[3] Mic levels for 6 seconds. STAY QUIET 3s, then SPEAK 3s:")
SR, BLK = 16000, 1600
q = queue.Queue()
with sd.RawInputStream(samplerate=SR, blocksize=BLK, dtype="int16", channels=1,
                       callback=lambda d, f, t, s: q.put(bytes(d))):
    t0 = time.time()
    peak_quiet, peak_loud = 0, 0
    while time.time() - t0 < 6:
        b = q.get()
        rms = float(np.sqrt(np.mean(np.frombuffer(b, np.int16).astype(np.float32) ** 2)))
        elapsed = time.time() - t0
        if elapsed < 3:
            peak_quiet = max(peak_quiet, rms)
        else:
            peak_loud = max(peak_loud, rms)
        print(f"   {elapsed:4.1f}s  rms={rms:7.0f}", end="\r")
print(f"\n    quiet peak: {peak_quiet:.0f}   speaking peak: {peak_loud:.0f}")
print(f"    -> good START_RMS would be about {int((peak_quiet + peak_loud) / 2)}")

# 4. Groq key + chat
print("\n[4] Groq API:")
try:
    key = json.load(open("config.json", encoding="utf-8-sig"))["groq_api_key"]
    r = requests.post("https://api.groq.com/openai/v1/chat/completions",
                      headers={"Authorization": f"Bearer {key}"},
                      json={"model": "openai/gpt-oss-20b",
                            "messages": [{"role": "user", "content": "say OK"}]},
                      timeout=20)
    print("    chat status:", r.status_code, "-", r.json()["choices"][0]["message"]["content"][:40])
except Exception as e:
    print("    ERROR:", e)

# 5. Piper voice
print("\n[5] Piper voice:")
try:
    from piper import PiperVoice
    v = PiperVoice.load("voices/en_US-kusal-medium.onnx")
    tmp = os.path.join(tempfile.gettempdir(), "diag.wav")
    with wave.open(tmp, "wb") as wf:
        v.synthesize_wav("Diagnostic complete.", wf)
    import winsound
    winsound.PlaySound(tmp, winsound.SND_FILENAME)
    print("    played a test phrase - did you hear it?")
except Exception as e:
    print("    ERROR:", e)

print("\n" + "=" * 50)
print("Done. Copy everything above and send it.")
print("=" * 50)
