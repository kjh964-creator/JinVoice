"""Turn the upstream VoiceStudio tree into JinVoice. Idempotent.

Every anchored replacement must match exactly once (or already be applied);
anything else fails loudly so an upstream change cannot slip through.
Run: python jinvoice/apply_branding.py   then   python jinvoice/check_branding.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NAME = 'JinVoice'
REPO = 'kjh964-creator/JinVoice'
UPSTREAM_REPO = 'debpalash/VoiceStudio'
DESKTOP_ID = 'com.jinvoice.desktop'
ANDROID_ID = 'com.jinvoice.mobile'
DATA_FOLDER = 'JinVoiceData'   # backend data (voices, outputs, db) -> %APPDATA%\JinVoiceData


def read(rel):
    return (ROOT / rel).read_text(encoding='utf-8')


def write(rel, text):
    (ROOT / rel).write_bytes(text.encode('utf-8'))


def anchored(rel, old, new, count=1):
    text = read(rel)
    if new in text and old not in text:
        return
    found = text.count(old)
    if found != count:
        sys.exit(f'{rel}: expected {count} x {old!r}, found {found}')
    write(rel, text.replace(old, new))


def main():
    # 1. Product identity (window title, exe name, installer, userData folder).
    cfg = json.loads(read('config/app.json'))
    cfg.update(productName=NAME, appId=DESKTOP_ID)
    write('config/app.json', json.dumps(cfg, indent=2) + '\n')

    # 2. Updates come from our own releases, never upstream's.
    anchored('electron/electron-builder.config.mjs',
             f"https://github.com/{UPSTREAM_REPO}/releases/latest/download",
             f"https://github.com/{REPO}/releases/latest/download")
    upd = 'electron/src/main/updater.ts'
    text = read(upd)
    if UPSTREAM_REPO in text:
        if text.count(UPSTREAM_REPO) != 4:
            sys.exit(f'{upd}: expected 4 upstream URLs, found {text.count(UPSTREAM_REPO)}')
        write(upd, text.replace(UPSTREAM_REPO, REPO))
    anchored('backend/core/links.py', f'"https://github.com/{UPSTREAM_REPO}"', f'"https://github.com/{REPO}"')

    # 3. Own data folder beside an installed VoiceStudio (models cache stays shared).
    anchored('backend/core/config.py', '"~/Library/Application Support/OmniVoice"',
             f'"~/Library/Application Support/{DATA_FOLDER}"')
    anchored('backend/core/config.py', 'os.path.join(os.environ.get("APPDATA", ""), "OmniVoice")',
             f'os.path.join(os.environ.get("APPDATA", ""), "{DATA_FOLDER}")')
    anchored('backend/core/config.py', 'return os.path.expanduser("~/.omnivoice")',
             'return os.path.expanduser("~/.jinvoice")')
    anchored('electron/src/main/reset-data.ts', "    'com.debpalash.omnivoice-studio',\n",
             "    'com.debpalash.omnivoice-studio',\n    'jinvoicedata',\n    'jinvoice',\n    '.jinvoice',\n")

    # 4. Visible strings: desktop catalogs + mobile contract. Keep the
    #    upstream web/email domain (voicestudio.sh) as attribution.
    pattern = re.compile(r'VoiceStudio(?![.]sh)')
    files = sorted((ROOT / 'electron/src/renderer/src/i18n/locales').glob('*.json'))
    files += sorted((ROOT / 'mobile/contract').glob('strings*.json'))
    for path in files:
        text = path.read_text(encoding='utf-8')
        fixed = pattern.sub(NAME, text)
        if fixed != text:
            json.loads(fixed)
            path.write_bytes(fixed.encode('utf-8'))

    # 5. Android: separate app id so it installs beside the store app.
    anchored('mobile/android/app/build.gradle.kts', 'applicationId = "sh.voicestudio.mobile"',
             f'applicationId = "{ANDROID_ID}"')
    print('branding applied')


if __name__ == '__main__':
    main()
