"""Copy JinhoVoice (PySide app) personal voices + generated history into JinVoice.

Originals are never modified: audio files are copied, rows are added.
Run only while JinVoice is closed. Re-running skips what was already imported
(matched by audio SHA-256 in the jinhovoice-import.json ledger).

  python import_jinhovoice.py [--source %LOCALAPPDATA%/JinhoVoiceStandalone]
                              [--target %APPDATA%/JinVoiceData] [--dry-run]
"""
import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import uuid
import wave
from datetime import datetime
from pathlib import Path

LEDGER = 'jinhovoice-import.json'   # in the target folder: audio sha256 -> imported id


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def duration(path):
    try:
        with wave.open(str(path), 'rb') as w:
            return round(w.getnframes() / w.getframerate(), 3)
    except (wave.Error, OSError, ZeroDivisionError):
        return None


def new_id(existing):
    while True:
        ident = uuid.uuid4().hex[:8]
        if ident not in existing:
            existing.add(ident)
            return ident


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument('--source', type=Path, default=Path(os.environ['LOCALAPPDATA']) / 'JinhoVoiceStandalone')
    p.add_argument('--target', type=Path, default=Path(os.environ['APPDATA']) / 'JinVoiceData')
    p.add_argument('--dry-run', action='store_true')
    a = p.parse_args(argv)
    db_path = a.target / 'omnivoice.db'
    if not db_path.is_file():
        sys.exit(f'JinVoice database not found: {db_path} (start JinVoice once, then close it)')
    voices = json.loads((a.source / 'data' / 'voices.json').read_text(encoding='utf-8'))
    voices = voices if isinstance(voices, list) else voices.get('voices', [])
    history = json.loads((a.source / 'data' / 'history.json').read_text(encoding='utf-8'))
    (a.target / 'voices').mkdir(exist_ok=True)
    (a.target / 'outputs').mkdir(exist_ok=True)

    db = sqlite3.connect(db_path)
    db.execute('PRAGMA foreign_keys=ON')
    ids = {r[0] for r in db.execute('SELECT id FROM voice_profiles')} | {r[0] for r in db.execute('SELECT id FROM generation_history')}
    ledger_path = a.target / LEDGER
    ledger = json.loads(ledger_path.read_text(encoding='utf-8')) if ledger_path.is_file() else {'voices': {}, 'history': {}}
    live_voices = {r[0] for r in db.execute('SELECT id FROM voice_profiles')}
    live_history = {r[0] for r in db.execute('SELECT id FROM generation_history')}
    done_voices = {d: i for d, i in ledger['voices'].items() if i in live_voices}
    done_history = {d: i for d, i in ledger['history'].items() if i in live_history}
    report = {'voices_added': [], 'voices_skipped': [], 'history_added': 0, 'history_skipped': 0, 'missing_files': []}
    by_name = {}
    copied = []
    try:
        for v in voices:
            if v.get('kind') == 'preset':
                continue
            src = Path(v.get('audio_path', ''))
            if not src.is_file():
                report['missing_files'].append(str(src)); continue
            digest = sha256(src)
            if digest in done_voices:
                by_name.setdefault(v['name'], done_voices[digest]); report['voices_skipped'].append(v['name']); continue
            ident = new_id(ids)
            dest = a.target / 'voices' / f'{ident}.wav'
            if not a.dry_run:
                shutil.copy2(src, dest); copied.append(dest)
            created = src.stat().st_mtime
            db.execute(
                'INSERT INTO voice_profiles (id, name, ref_audio_path, ref_text, language, kind, description, created_at)'
                ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                (ident, v['name'], dest.name, v.get('transcript', ''), 'Auto', 'clone',
                 '', created))
            done_voices[digest] = ident
            by_name.setdefault(v['name'], ident)
            report['voices_added'].append(v['name'])
        for h in reversed(history):  # oldest first
            src = Path(h.get('output_path', ''))
            if not src.is_file():
                report['missing_files'].append(str(src)); continue
            digest = sha256(src)
            if digest in done_history:
                report['history_skipped'] += 1; continue
            ident = new_id(ids)
            dest = a.target / 'outputs' / f'{ident}.wav'
            if not a.dry_run:
                shutil.copy2(src, dest); copied.append(dest)
            try:
                created = datetime.fromisoformat(h['created']).timestamp()
            except (KeyError, ValueError):
                created = src.stat().st_mtime
            db.execute(
                'INSERT INTO generation_history (id, text, mode, language, instruct, profile_id, audio_path,'
                ' duration_seconds, generation_time, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
                (ident, (h.get('text') or '').strip(), 'clone', 'Korean', '', by_name.get(h.get('voice')),
                 dest.name, h.get('duration_seconds') or duration(src), h.get('elapsed_seconds'), created))
            done_history[digest] = ident
            report['history_added'] += 1
        if a.dry_run:
            db.rollback()
        else:
            db.commit()
            ledger_path.write_text(json.dumps({'voices': done_voices, 'history': done_history}, indent=2), encoding='utf-8')
    except Exception:
        db.rollback()
        for path in copied:
            path.unlink(missing_ok=True)
        raise
    finally:
        db.close()
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
