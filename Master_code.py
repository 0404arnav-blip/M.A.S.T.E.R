"""Entry point - kept so the existing shortcut still works.
Shows the startup chooser (Ollama vs Groq), then runs the voice assistant.
Real code lives in setup.py, brain.py and client_windows.py."""

import apppath  # noqa: F401  (must be first - sets the working dir)
import setup
setup.choose()          # may write config.json before brain.py reads it

import client_windows
client_windows.run()
