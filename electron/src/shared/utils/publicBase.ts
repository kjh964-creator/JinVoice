/**
 * Deployment base path of the built UI (Vite `base`, exposed as
 * `import.meta.env.BASE_URL`).
 *
 * The desktop app and the default web build use `/`, so every helper here
 * returns exactly the legacy root-relative value for them. A web build made
 * with `JINVOICE_WEB_BASE=/some/prefix/` (served behind a reverse proxy that
 * strips that prefix) gets `/some/prefix/...` instead, so static files and
 * same-origin backend routes keep the public prefix.
 */

function readBaseUrl(): string | undefined {
  const env = (import.meta as unknown as { env?: Record<string, unknown> }).env;
  const value = env?.BASE_URL;
  return typeof value === 'string' ? value : undefined;
}

/** `/jinvoice/app` for base `/jinvoice/app/`; `''` for `/`, relative or unset bases. */
export function basePathPrefix(baseUrl: string | undefined = readBaseUrl()): string {
  if (typeof baseUrl !== 'string') return '';
  const trimmed = baseUrl.trim();
  // Only an absolute path prefix changes anything. `./` (relative builds) and
  // full URLs keep the legacy root-relative behaviour.
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return '';
  return trimmed.replace(/\/+$/, '');
}

/** URL of a file from `electron/public` (e.g. `aec-worklet.js`). */
export function publicAssetUrl(name: string, baseUrl: string | undefined = readBaseUrl()): string {
  return `${basePathPrefix(baseUrl)}/${name.replace(/^\/+/, '')}`;
}
