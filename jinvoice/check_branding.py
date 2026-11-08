"""Fails unless the tree is branded as JinVoice (run after apply_branding.py)."""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
errors = []


def has(rel, needle, expect=True):
    text = (ROOT / rel).read_text(encoding='utf-8')
    if (needle in text) != expect:
        errors.append(f"{rel}: {'missing' if expect else 'still has'} {needle!r}")


cfg = json.loads((ROOT / 'config/app.json').read_text(encoding='utf-8'))
if cfg.get('productName') != 'JinVoice' or cfg.get('appId') != 'com.jinvoice.desktop':
    errors.append('config/app.json not branded')
for rel in ['electron/electron-builder.config.mjs', 'electron/src/main/updater.ts', 'backend/core/links.py']:
    has(rel, 'debpalash/VoiceStudio', expect=False)
    has(rel, 'kjh964-creator/JinVoice')
has('backend/core/config.py', '"JinVoiceData"')
has('electron/src/main/reset-data.ts', "'jinvoicedata'")
has('electron/tests/packaged-smoke.mjs', 'win-unpacked/JinVoice.exe')
has('mobile/android/app/build.gradle.kts', 'applicationId = "com.jinvoice.mobile"')
visible = re.compile(r'VoiceStudio(?![.]sh)')
for path in list((ROOT / 'electron/src/renderer/src/i18n/locales').glob('*.json')) + list((ROOT / 'mobile/contract').glob('strings*.json')):
    if visible.search(path.read_text(encoding='utf-8')):
        errors.append(f'{path.relative_to(ROOT)}: visible VoiceStudio string')
en = json.loads((ROOT / 'electron/src/renderer/src/i18n/locales/en.json').read_text(encoding='utf-8'))
if en['app']['name'] != 'JinVoice':
    errors.append('en.json app.name (Android label) is not JinVoice')
if errors:
    print('\n'.join(errors)); sys.exit(1)
print('branding OK')
