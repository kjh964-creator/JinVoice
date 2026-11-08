"""Pack JinVoice personal data for the mini PC: consistent DB copy + voices + outputs,
encrypted with Fernet. Prints the key (pass it only inside the mini-PC task).
  python pack_data.py <out.b64>
"""
import io, os, sqlite3, sys, tempfile, zipfile, hashlib
from pathlib import Path
from cryptography.fernet import Fernet

src = Path(os.environ['APPDATA']) / 'JinVoiceData'
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    tmp = Path(tempfile.mkdtemp()) / 'omnivoice.db'
    s = sqlite3.connect(src / 'omnivoice.db'); d = sqlite3.connect(tmp)
    s.backup(d); d.close(); s.close()
    z.write(tmp, 'omnivoice.db')
    for name in ['prefs.json', 'jinhovoice-import.json']:
        if (src / name).is_file():
            z.write(src / name, name)
    for folder in ['voices', 'outputs']:
        for p in (src / folder).rglob('*'):
            if p.is_file():
                z.write(p, p.relative_to(src).as_posix())
    names = z.namelist()
key = Fernet.generate_key()
token = Fernet(key).encrypt(buf.getvalue())
Path(sys.argv[1]).write_bytes(token)
print('files', len(names), 'zip', len(buf.getvalue()), 'enc', len(token), 'sha256', hashlib.sha256(token).hexdigest())
Path(sys.argv[1] + '.key').write_bytes(key)
