"""Make a ready-to-use M.A.S.T.E.R pendrive - plug it in and go, nothing to install.

    python make_usb.py E:                    # ready to go: the Groq key from config.json is baked in
    python make_usb.py E: --no-key           # no key: the person is asked for their OWN on first start
    python make_usb.py E: --key-file K.json  # use a different key (a config.json or a plain text file)
    python make_usb.py E: --build            # run build.bat first, so the stick gets the latest code

Run it again on a stick that is already in use to UPDATE the program: the person's own
settings, chats, memory, reminders and documents on the stick are left alone (settings are
only replaced if you add --reset-config).

What goes on the stick
    MASTER\\             the Windows program, in portable mode (everything it saves stays here)
    MASTER-Phone\\       a single-file version for Android (saves nothing on the phone)
    README-FIRST.txt    plain instructions for whoever holds the stick

The key goes onto sticks ONLY. It is never written into the project folder, the git
repository, or the build that is published on GitHub. The key is never printed.

Windows only. Needs the build in dist\\MASTER (run build.bat, or pass --build).
"""

import argparse
import ctypes
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
DIST = ROOT / "dist" / "MASTER"
sys.path.insert(0, str(ROOT / "mobile"))
import build_portable  # noqa: E402  (the single-file phone builder)

PORTABLE_NOTE = ("Portable mode: M.A.S.T.E.R keeps everything it creates inside this folder. "
                 "Delete this file to make it use the PC's Documents folder instead.\n")

BLANK_CONFIG = {"groq_api_key": "", "backend": "ollama", "ask_on_start": True}


def fail(msg):
    sys.exit(f"\nERROR: {msg}")


def drive_is_removable(root: pathlib.Path) -> bool:
    try:
        return ctypes.windll.kernel32.GetDriveTypeW(str(root.anchor)) == 2   # DRIVE_REMOVABLE
    except Exception:
        return False


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def folder_size(path: pathlib.Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def readme(key_baked: bool, google_baked: bool = False) -> str:
    google_note = (
        "   Google Docs / Sheets: ask for a document and, the first time, M.A.S.T.E.R shows a short code -\n"
        "   open google.com/device, enter it and approve. (You must be listed as a test user of the\n"
        "   Google project, or have it published.) Nothing is saved on the phone, so you do this each time.\n"
        if google_baked else "")
    if key_baked:
        first_start = (
            "It needs an internet connection (it thinks using Groq). A free Groq key is already on\n"
            "this stick, so there is nothing to set up.")
        phone_key = "The key is already inside that file, so there is nothing to paste."
        safety = (
            "KEEP THIS STICK SAFE\n"
            "--------------------\n"
            "A free Groq key is stored on this stick (MASTER\\config.json and\n"
            "MASTER-Phone\\MASTER-phone.html), so anyone who has the stick can read and use it.\n"
            "If the stick is ever lost: go to https://console.groq.com/keys , delete that key and make\n"
            "a new one. Groq's free speed limit applies to the whole Groq account, so sticks made with\n"
            "keys from the same account share it - give each person a key from their own account.\n")
    else:
        first_start = (
            "It needs an internet connection. The first time you start it, a small window asks how it\n"
            "should think: choose \"Use Groq\" and paste your own FREE key (get one at\n"
            "https://console.groq.com/keys - it takes a minute). The key is saved on this stick only.")
        phone_key = ("This stick has no key in it, so paste your Groq key when the page asks (it is not\n"
                     "saved on the phone, so you paste it each time you open the page).")
        safety = (
            "YOUR KEY\n"
            "--------\n"
            "Your Groq key is saved in MASTER\\config.json on this stick. Anyone who has the stick can\n"
            "read it. If the stick is ever lost, delete the key at https://console.groq.com/keys .\n")
    return f"""M.A.S.T.E.R  -  portable copy
=============================

This stick holds everything. Nothing is installed on the PC or phone you plug it into.

ON A WINDOWS PC
---------------
1. Open the MASTER folder and double-click MASTER.exe.
   - Windows may say "unknown publisher": click "More info" then "Run anyway".
   - The first start from a USB stick is slow (about 10-15 seconds). That is the stick, not a fault.
2. {first_start}
3. Everything it saves - settings, chats, memory, reminders, to-do list, and any documents it
   makes (MASTER\\Documents) - stays inside the MASTER folder on this stick.
   Its spoken replies are played from memory and are never written to the PC.
4. Close M.A.S.T.E.R before you unplug the stick ("Safely remove" is best).

What cannot be avoided: Windows itself may keep its own traces of a program having run
(recent-files list, SmartScreen / antivirus logs). None of M.A.S.T.E.R's data is left behind.
Tools that act on the PC (open apps, find files, volume, lock, screenshots) act on whichever
PC the stick is in. The optional "On this PC" thinking mode needs Ollama installed on that PC;
Groq needs nothing installed.

ON AN ANDROID PHONE
-------------------
1. Plug the stick in (USB-C, or an OTG adapter).
2. Open the Files app, open the stick, open the MASTER-Phone folder, and long-press
   MASTER-phone.html, then choose  Open with  >  Chrome.
   If another app (for example WPS Office) grabs the file and says it can't open it: go to
   Settings > Apps > that app > Open by default > Clear defaults, then try again and pick
   Chrome ("Just once").
3. {phone_key}
4. Tap the mic and allow the microphone when asked. If the mic is blocked you can still type.
5. USB mode saves NOTHING on the phone: chats, memory and reminders last only until you
   close the page. Reminders ring only while the page is open.
{google_note}

iPHONE: an iPhone cannot run a web app from a USB stick (its Files app only previews HTML).

{safety}"""


def main():
    ap = argparse.ArgumentParser(description="Make a ready-to-use M.A.S.T.E.R pendrive.")
    ap.add_argument("drive", help="the pendrive, e.g. E: or E:\\")
    ap.add_argument("--no-key", action="store_true", help="don't include a key; the person adds their own")
    ap.add_argument("--key-file", help="take the key from this config.json / text file instead of ./config.json")
    ap.add_argument("--google-file", help="bake the Google Docs/Sheets client (Client ID + secret) into the "
                                          "phone file; see mobile/GOOGLE-SETUP.md")
    ap.add_argument("--build", action="store_true", help="run build.bat first")
    ap.add_argument("--reset-config", action="store_true", help="replace the settings already on the stick")
    ap.add_argument("--allow-fixed", action="store_true", help="allow a target that isn't a removable drive")
    a = ap.parse_args()

    target = pathlib.Path(a.drive if a.drive.endswith(("\\", "/")) or len(a.drive) > 3 else a.drive + "\\")
    if not target.is_dir():
        fail(f"{target} is not an available drive or folder")
    if not a.allow_fixed and not drive_is_removable(target):
        fail(f"{target.anchor} is not a removable drive. Refusing, so a hard drive isn't filled by mistake "
             "(add --allow-fixed if you really mean it).")
    if a.no_key and a.key_file:
        fail("use either --no-key or --key-file, not both")
    # never copy onto the project itself (Windows paths ignore case: D:\ + MASTER == D:\master)
    resolved = (target / "MASTER").resolve()
    if resolved == ROOT or ROOT in resolved.parents or resolved in ROOT.parents or target.resolve() == ROOT:
        fail(f"{target} would overwrite this project folder. Give it the pendrive, e.g. E:")

    key = None
    if not a.no_key:
        source = pathlib.Path(a.key_file) if a.key_file else ROOT / "config.json"
        try:
            key = build_portable.read_key(source)
        except (OSError, ValueError) as e:
            fail(f"couldn't get a Groq key from {source} ({e}). Use --key-file, or --no-key to make a stick "
                 "where the person adds their own.")

    google = None
    if a.google_file:
        try:
            google = build_portable.read_google(a.google_file)
        except (OSError, ValueError) as e:
            fail(f"couldn't read the Google client from {a.google_file} ({e})")

    if a.build:
        print("building the program (build.bat) ...")
        # full path: with NoDefaultCurrentDirectoryInExePath set, cmd won't find "build.bat" in the cwd
        if subprocess.run(["cmd", "/c", str(ROOT / "build.bat")], cwd=ROOT).returncode != 0:
            fail("build.bat failed")
    if not (DIST / "MASTER.exe").exists():
        fail(r"dist\MASTER\MASTER.exe not found - run build.bat first (or pass --build)")

    dst = target / "MASTER"
    updating = (dst / "MASTER.exe").exists()
    need = folder_size(DIST) + 50 * 1024 * 1024
    free = shutil.disk_usage(target).free
    if not updating and free < need:
        fail(f"not enough space on {target.anchor}: need {need // 2**20} MB, only {free // 2**20} MB free")

    print(f"{'updating' if updating else 'creating'} the stick at {target}")
    # /E copies everything; the one top-level config.json in the build is the blank example,
    # which must never overwrite the person's own settings (excluded by its full path).
    rc = subprocess.run(
        ["robocopy", str(DIST), str(dst), "/E", "/XF", str(DIST / "config.json"),
         "/R:2", "/W:2", "/NFL", "/NDL", "/NP", "/NJH", "/NJS"],
        capture_output=True, text=True).returncode
    if rc >= 8:
        fail(f"copying failed (robocopy code {rc}). Is MASTER running from the stick? Close it and retry.")

    (dst / "portable.txt").write_text(PORTABLE_NOTE, encoding="ascii")

    cfg_path = dst / "config.json"
    if cfg_path.exists() and not a.reset_config:
        print("  settings: kept the ones already on the stick (use --reset-config to replace)")
        cfg_note = "existing settings kept"
    else:
        cfg = ({"groq_api_key": key, "backend": "groq", "ask_on_start": False} if key else BLANK_CONFIG)
        cfg_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
        cfg_note = "key included, starts straight away" if key else "no key, asks for the person's own on first start"
    # what the stick will really do on first start, whatever just happened above
    try:
        on_stick = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
    except ValueError:
        on_stick = {}
    stick_has_key = bool(str(on_stick.get("groq_api_key", "")).strip())

    phone_dir = target / "MASTER-Phone"
    phone_dir.mkdir(exist_ok=True)
    (phone_dir / "MASTER-phone.html").write_text(build_portable.build(key, google), encoding="utf-8", newline="\n")

    (target / "README-FIRST.txt").write_text(readme(bool(key), bool(google)), encoding="ascii", newline="\r\n")

    ok = sha256(DIST / "MASTER.exe") == sha256(dst / "MASTER.exe")
    files = sum(1 for p in target.rglob("*") if p.is_file() and "System Volume Information" not in p.parts)
    print("\nDone.")
    print(f"  program on stick matches the build : {'yes' if ok else 'NO - copy is damaged, run again'}")
    print(f"  PC settings                        : {cfg_note}")
    print(f"  phone file                         : {'key baked in' if key else 'no key (paste on the phone)'}")
    print(f"  size on stick                      : {folder_size(target) // 2**20} MB in {files} files")
    if stick_has_key or key:
        print("  REMINDER: this stick holds a Groq key in plain text - treat it like a password.")
    if google:
        print("  REMINDER: the phone file also holds your Google client ID and secret in plain text.")
    print("\nEject the stick with 'Safely remove hardware' before unplugging it.")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
