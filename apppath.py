"""Sets the working directory to where M.A.S.T.E.R lives, whether it's run as
plain Python scripts or as a packaged .exe. Import this FIRST in every entry module."""

import os
import sys

if getattr(sys, "frozen", False):            # packaged with PyInstaller
    BASE = os.path.dirname(sys.executable)
else:                                        # running from source
    BASE = os.path.dirname(os.path.abspath(__file__))

os.chdir(BASE)

LOG_FILE = os.path.join(BASE, "master_error.log")
