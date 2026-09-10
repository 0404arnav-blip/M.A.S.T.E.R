# PyInstaller spec for M.A.S.T.E.R  -  build with:  pyinstaller MASTER.spec
from PyInstaller.utils.hooks import collect_all, collect_data_files

datas, binaries, hiddenimports = [], [], []

for pkg in ("piper", "onnxruntime", "sounddevice", "soundfile"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# python-docx / python-pptx ship default templates as package data
datas += collect_data_files("docx")
datas += collect_data_files("pptx")

hiddenimports += [
    "win32com", "win32com.client", "win32timezone",
    "tkinter", "pptx", "docx", "openpyxl", "pypdf",
    "PIL.ImageGrab", "ddgs", "numpy",
]

a = Analysis(
    ["Master_code.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    excludes=["fastapi", "uvicorn", "pywebview", "pyttsx3", "openwakeword"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="MASTER",
    console=False,               # GUI app - errors go to master_error.log
    icon="master.ico",
)

coll = COLLECT(
    exe, a.binaries, a.datas,
    name="MASTER",
    contents_directory="_internal",
)
