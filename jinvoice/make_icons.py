"""Render jinvoice/logo.svg into every desktop icon slot + docs/logo.svg + favicon.

Uses headless Edge (transparent background) and Pillow. Run on Windows:
  python jinvoice/make_icons.py
"""
import shutil
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
LOGO = ROOT / 'jinvoice' / 'logo.svg'
EDGE = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
ICONS = ROOT / 'electron' / 'build' / 'icons'


def render(size, out):
    html = Path(tempfile.mkdtemp()) / 'r.html'
    svg = LOGO.read_text(encoding='utf-8').replace('width="512" height="512"', f'width="{size}" height="{size}"')
    html.write_text(f'<html><body style="margin:0;background:transparent">{svg}</body></html>', encoding='utf-8')
    subprocess.run([EDGE, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                    '--default-background-color=00000000', f'--window-size={size},{size}',
                    f'--screenshot={out}', html.as_uri()], check=True, capture_output=True, timeout=60)
    image = Image.open(out).convert('RGBA').crop((0, 0, size, size))
    image.save(out)
    return image


def main():
    work = Path(tempfile.mkdtemp())
    big = render(1024, work / 'big.png')
    big.resize((512, 512), Image.LANCZOS).save(ICONS / 'icon.png')
    big.resize((32, 32), Image.LANCZOS).save(ICONS / '32x32.png')
    big.save(ICONS / 'icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    big.save(ICONS / 'icon.icns')
    tray = big.resize((128, 128), Image.LANCZOS)
    draw = ImageDraw.Draw(tray)
    draw.ellipse((70, 70, 124, 124), fill=(255, 59, 79, 255), outline=(255, 255, 255, 255), width=6)
    tray.resize((32, 32), Image.LANCZOS).save(ICONS / 'tray-recording.png')
    shutil.copyfile(LOGO, ROOT / 'docs' / 'logo.svg')
    favicon = LOGO.read_text(encoding='utf-8').replace(' width="512" height="512"', '')
    (ROOT / 'electron' / 'public' / 'favicon.svg').write_text(favicon, encoding='utf-8')
    big.resize((256, 256), Image.LANCZOS).save(ROOT / 'jinvoice' / 'icon-preview.png')
    print('icons written')


if __name__ == '__main__':
    main()
