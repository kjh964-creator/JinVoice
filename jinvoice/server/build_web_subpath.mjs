#!/usr/bin/env node
// Build the JinVoice web UI for a reverse-proxy subpath and zip it.
//
//   node jinvoice/server/build_web_subpath.mjs [base]      (default base: /jinvoice/app/)
//
// Output: jinvoice/server/out/jinvoice-web-<version>.zip (index.html at the zip
// root) + .sha256. The normal frontend/dist (desktop installer) is not touched.
// Serve it with the backend: OMNIVOICE_FRONTEND_DIST=<unzipped folder>.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const electron = join(repo, 'electron');
const base = process.argv[2] || '/jinvoice/app/';
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
const outDir = join(here, 'out');
const distDir = join(outDir, 'web-dist');
const zipPath = join(outDir, `jinvoice-web-${version}.zip`);

mkdirSync(outDir, { recursive: true });
rmSync(distDir, { recursive: true, force: true });
const vite = join(electron, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.exe' : 'vite');
const run = spawnSync(vite, ['build', '--config', 'vite.web.config.ts'], {
  cwd: electron,
  stdio: 'inherit',
  env: { ...process.env, JINVOICE_WEB_BASE: base, JINVOICE_WEB_OUT: distDir },
});
if (run.status !== 0) process.exit(run.status ?? 1);

// Web-only extra: the "who is signed in / logout" chip (not in desktop builds).
{
  const p = join(distDir, 'index.html');
  const pfx = `/${base.replace(/^\/+|\/+$/g, '')}/`;
  writeFileSync(join(distDir, 'jv-user.js'), readFileSync(join(here, 'jv-user.js')));
  // Installable on phones ("홈 화면에 추가"): the manifest and icons live on the
  // public homepage (/jinvoice/), so they load without the login cookie.
  writeFileSync(
    p,
    readFileSync(p, 'utf8').replace(
      '</head>',
      '  <link rel="manifest" href="/jinvoice/app.webmanifest">\n' +
        '  <meta name="theme-color" content="#5B6CFF">\n' +
        '  <link rel="apple-touch-icon" href="/jinvoice/assets/app-192.png">\n  </head>',
    ),
  );
  writeFileSync(p, readFileSync(p, 'utf8').replace('</body>', `  <script src="${pfx}jv-user.js" defer></script>\n  </body>`));
}

const index = readFileSync(join(distDir, 'index.html'), 'utf8');
const prefix = `/${base.replace(/^\/+|\/+$/g, '')}/`;
if (!index.includes(`src="${prefix}assets/`) || /(?:src|href)="\/(?:assets|favicon|early-error)/.test(index)) {
  console.error(`index.html does not use base ${prefix} for its assets`);
  process.exit(1);
}

function files(dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

// Minimal deterministic ZIP writer (deflate, fixed 1980-01-01 timestamps).
const locals = [];
const central = [];
let offset = 0;
for (const file of files(distDir)) {
  const name = Buffer.from(relative(distDir, file).split(sep).join('/'), 'utf8');
  const data = readFileSync(file);
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data) >>> 0;
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0x0800, 6); // UTF-8 names
  head.writeUInt16LE(8, 8);
  head.writeUInt16LE(0, 10);
  head.writeUInt16LE(0x21, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(packed.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(name.length, 26);
  locals.push(head, name, packed);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt16LE(0, 12);
  entry.writeUInt16LE(0x21, 14);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(packed.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, name);
  offset += head.length + name.length + packed.length;
}
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(central.length / 2, 8);
end.writeUInt16LE(central.length / 2, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...locals, centralBuf, end]);
if (existsSync(zipPath)) rmSync(zipPath);
writeFileSync(zipPath, zip);
const sha = createHash('sha256').update(zip).digest('hex');
writeFileSync(`${zipPath}.sha256`, `${sha}  jinvoice-web-${version}.zip\n`);
console.log(`base    ${prefix}`);
console.log(`files   ${central.length / 2}`);
console.log(`zip     ${zipPath}`);
console.log(`sha256  ${sha}`);
