"""Pack the phone app into ONE self-contained HTML file for running from a USB stick.

A phone opening a file from a pendrive can't load sibling files (no module imports, no
separate CSS), so everything is inlined. In this build nothing is ever written to the
phone's browser storage - chats, memory and reminders last only until the page closes.

    python build_portable.py OUT.html                       # no key: you paste it on the phone
    python build_portable.py OUT.html --with-key            # bakes in the key from ../config.json
    python build_portable.py OUT.html --key-file PATH       # ...or from another config.json / text file

A baked-in key sits in OUT.html in plain text. Keep that file on the stick only; never
commit it or share it.
"""

import argparse
import json
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
MODULES = ["store", "google", "tools", "brain", "app"]          # dependency order

IMPORT_RE = re.compile(r"^import\s*\{([^}]*)\}\s*from\s*'\./(\w+)\.js';?[ \t]*$", re.M)
EXPORT_NAME_RE = re.compile(r"^export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)", re.M)


def wrap(name: str) -> str:
    src = (HERE / f"{name}.js").read_text(encoding="utf-8")
    exports = EXPORT_NAME_RE.findall(src)
    src = IMPORT_RE.sub(lambda m: f"const {{{m.group(1).strip()}}} = __m_{m.group(2)};", src)
    src = re.sub(r"^export\s+", "", src, flags=re.M)
    if re.search(r"^\s*import\s", src, re.M) or "import(" in src or "import.meta" in src:
        sys.exit(f"{name}.js uses an import form the bundler doesn't handle")
    return (f"/* ---- {name}.js ---- */\n"
            f"const __m_{name} = (() => {{\n{src}\nreturn {{ {', '.join(exports)} }};\n}})();\n")


def read_key(path) -> str:
    """A Groq key from a config.json ({"groq_api_key": ...}) or a plain text file."""
    text = pathlib.Path(path).read_text(encoding="utf-8-sig").strip()
    try:
        key = str(json.loads(text).get("groq_api_key", "")).strip()
    except (ValueError, AttributeError):
        key = text.splitlines()[0].strip() if text else ""
    if not key or key == "gsk_your_key_here":
        raise ValueError(f"no Groq key found in {path}")
    return key


def read_google(path) -> dict:
    """The Google Cloud client (Client ID + secret) for Docs/Sheets. Accepts our own
    {"googleClientId", "googleClientSecret"}, {"client_id", "client_secret"}, or the JSON Google
    lets you download ({"installed": {...}} / {"web": {...}})."""
    raw = json.loads(pathlib.Path(path).read_text(encoding="utf-8-sig"))
    inner = raw.get("installed") or raw.get("web") or raw
    cid = str(inner.get("googleClientId") or inner.get("client_id") or "").strip()
    secret = str(inner.get("googleClientSecret") or inner.get("client_secret") or "").strip()
    if not cid or not secret:
        raise ValueError(f"no Google client id/secret found in {path}")
    return {"googleClientId": cid, "googleClientSecret": secret}


def build(key=None, google=None) -> str:
    """Return the single-file HTML. `key` (optional) is baked in as the starting Groq key;
    `google` (optional) is the Docs/Sheets client from read_google()."""
    boot = {"key": key} if key else {}
    if google:
        boot.update(google)

    js = ("window.MASTER_PORTABLE = true;\n"
          f"window.MASTER_BOOT = {json.dumps(boot)};\n"
          + "\n".join(wrap(m) for m in MODULES))
    js = js.replace("</script", "<\\/script").replace("<!--", "<\\!--")

    html = (HERE / "index.html").read_text(encoding="utf-8")
    css = (HERE / "style.css").read_text(encoding="utf-8")
    html = re.sub(r'<link rel="manifest"[^>]*>\s*', "", html)
    html = re.sub(r'<link rel="(?:apple-touch-icon|icon)"[^>]*>\s*', "", html)
    html = html.replace('<link rel="stylesheet" href="style.css">', f"<style>\n{css}\n</style>")
    html = html.replace('<script type="module" src="app.js"></script>', f"<script>\n{js}\n</script>")
    if 'src="app.js"' in html or 'href="style.css"' in html:
        sys.exit("failed to inline everything")
    return html


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--with-key", action="store_true", help="bake in the key from ../config.json")
    ap.add_argument("--key-file", help="bake in the key from this config.json / text file")
    ap.add_argument("--google-file", help="bake in the Google Docs/Sheets client (see GOOGLE-SETUP.md)")
    a = ap.parse_args()
    key = None
    google = None
    try:
        if a.key_file:
            key = read_key(a.key_file)
        elif a.with_key:
            key = read_key(HERE.parent / "config.json")
        if a.google_file:
            google = read_google(a.google_file)
    except (OSError, ValueError) as e:
        sys.exit(str(e))
    out = pathlib.Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(build(key, google), encoding="utf-8", newline="\n")
    print(f"wrote {out} ({out.stat().st_size:,} bytes), key baked in: {bool(key)}, google client baked in: {bool(google)}")
