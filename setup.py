"""First-run / startup chooser. Asks whether Master should think locally (Ollama)
or via a Groq key, and writes the choice to config.json.

Called by Master_code.py before the assistant starts. If config.json already has
a backend and "ask_on_start" is false, it returns immediately with no window.
"""

import os
import json
import webbrowser

os.chdir(os.path.dirname(os.path.abspath(__file__)))

CONFIG_FILE = "config.json"
GROQ_KEYS_PAGE = "https://console.groq.com/keys"


def _load():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8-sig") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def _save(cfg):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)


def _test_groq_key(key):
    try:
        import requests
        r = requests.get("https://api.groq.com/openai/v1/models",
                         headers={"Authorization": f"Bearer {key}"}, timeout=10)
        return r.status_code == 200
    except Exception:
        return False


def choose():
    cfg = _load()
    key_in_cfg = str(cfg.get("groq_api_key", "")).strip()
    if key_in_cfg == "gsk_your_key_here":
        key_in_cfg = ""

    # already decided and asked not to be bothered -> go straight in
    if cfg.get("backend") in ("ollama", "groq") and not cfg.get("ask_on_start", True):
        return

    try:
        import tkinter as tk
        from tkinter import ttk, messagebox
    except Exception:
        return  # no GUI available - just use whatever config already says

    result = {"done": False}
    win = tk.Tk()
    win.title("M.A.S.T.E.R")
    win.resizable(False, False)
    try:
        win.iconbitmap("master.ico")
    except Exception:
        pass

    pad = {"padx": 16, "pady": 6}
    tk.Label(win, text="How should M.A.S.T.E.R think?", font=("Segoe UI", 12, "bold")).grid(
        row=0, column=0, columnspan=3, sticky="w", **pad)

    mode = tk.StringVar(value=cfg.get("backend") or ("groq" if key_in_cfg else "ollama"))
    tk.Radiobutton(win, text="On this PC  —  free, works offline, a bit slower",
                   variable=mode, value="ollama").grid(row=1, column=0, columnspan=3, sticky="w", padx=16)
    tk.Radiobutton(win, text="Use Groq  —  much faster, needs a free key",
                   variable=mode, value="groq").grid(row=2, column=0, columnspan=3, sticky="w", padx=16)

    tk.Label(win, text="Groq key:").grid(row=3, column=0, sticky="e", padx=(16, 4), pady=(10, 4))
    key_var = tk.StringVar(value=key_in_cfg)
    key_entry = tk.Entry(win, textvariable=key_var, width=34, show="•")
    key_entry.grid(row=3, column=1, sticky="w", pady=(10, 4))
    ttk.Button(win, text="Get a free key",
               command=lambda: webbrowser.open(GROQ_KEYS_PAGE)).grid(row=3, column=2, padx=(4, 16))

    status = tk.Label(win, text="", fg="#666")
    status.grid(row=4, column=0, columnspan=3, sticky="w", padx=16)

    dont_ask = tk.BooleanVar(value=not cfg.get("ask_on_start", True))
    tk.Checkbutton(win, text="Don't ask next time", variable=dont_ask).grid(
        row=5, column=0, columnspan=3, sticky="w", padx=14, pady=(4, 2))

    def start():
        chosen = mode.get()
        new = dict(cfg)
        new["backend"] = chosen
        new["ask_on_start"] = not dont_ask.get()
        if chosen == "groq":
            k = key_var.get().strip()
            if not k:
                status.config(text="Paste a Groq key, or pick 'On this PC'.", fg="#b00")
                return
            status.config(text="Checking key…", fg="#666")
            win.update()
            if not _test_groq_key(k):
                status.config(text="That key didn't work. Check it and try again.", fg="#b00")
                return
            new["groq_api_key"] = k
        _save(new)
        result["done"] = True
        win.destroy()

    ttk.Button(win, text="Start M.A.S.T.E.R", command=start).grid(
        row=6, column=0, columnspan=3, pady=12)

    win.update_idletasks()
    x = (win.winfo_screenwidth() - win.winfo_width()) // 2
    y = (win.winfo_screenheight() - win.winfo_height()) // 3
    win.geometry(f"+{x}+{y}")
    win.mainloop()

    if not result["done"] and cfg.get("backend") not in ("ollama", "groq"):
        raise SystemExit(0)   # closed without ever choosing and nothing usable configured


if __name__ == "__main__":
    choose()
    print("config:", _load())
