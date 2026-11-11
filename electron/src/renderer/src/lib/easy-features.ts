import { useSyncExternalStore } from 'react';

/**
 * JinVoice easy mode, per-feature switches. Every original VoiceStudio
 * workspace (the full UI's navigation) can be switched on one by one: an ON
 * feature shows on the easy home under "More features" and its route opens
 * inside easy mode; an OFF feature stays hidden exactly as before. Saved in
 * localStorage, all OFF by default, so the easy screen is unchanged until the
 * user picks something. "Show all features (advanced)" in Settings still
 * turns the whole easy mode off and shows everything at once.
 *
 * The list follows the full UI's navigation (components/app-shell/workspace-menu.tsx),
 * plus JinVoice's own easy screens that are off until switched on (song cover,
 * song from a story).
 */
export const EASY_FEATURES_STORAGE_KEY = 'jinvoice.easy-features.v1';

export const EASY_FEATURE_IDS = [
  'clone',
  'design',
  'personas',
  'gallery',
  'stories',
  'audiobook',
  'dub',
  'batch',
  'transcriptions',
  'calls',
  'projects',
  'tools',
  'integrations',
  'cover',
  'story_song',
] as const;

export type EasyFeatureId = (typeof EASY_FEATURE_IDS)[number];

export type EasyFeaturePath =
  | '/clone'
  | '/design'
  | '/personas'
  | '/gallery'
  | '/stories'
  | '/audiobook'
  | '/dub'
  | '/batch'
  | '/transcriptions'
  | '/calls'
  | '/projects'
  | '/tools'
  | '/integrations'
  | '/easy/cover'
  | '/easy/story-song';

/** The route each feature opens; sub-routes (e.g. `/integrations/<slug>`) belong to it too. */
export const EASY_FEATURE_PATHS: Record<EasyFeatureId, EasyFeaturePath> = {
  clone: '/clone',
  design: '/design',
  personas: '/personas',
  gallery: '/gallery',
  stories: '/stories',
  audiobook: '/audiobook',
  dub: '/dub',
  batch: '/batch',
  transcriptions: '/transcriptions',
  calls: '/calls',
  projects: '/projects',
  tools: '/tools',
  integrations: '/integrations',
  cover: '/easy/cover',
  story_song: '/easy/story-song',
};

const isFeatureId = (value: unknown): value is EasyFeatureId =>
  typeof value === 'string' && (EASY_FEATURE_IDS as readonly string[]).includes(value);

function readStored(): readonly EasyFeatureId[] {
  try {
    const raw = globalThis.localStorage?.getItem(EASY_FEATURES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Keep the catalogue order, drop unknown or repeated ids.
    return EASY_FEATURE_IDS.filter((id) => parsed.some((item) => isFeatureId(item) && item === id));
  } catch {
    return [];
  }
}

let enabled: readonly EasyFeatureId[] = readStored();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function sameList(a: readonly EasyFeatureId[], b: readonly EasyFeatureId[]) {
  return a.length === b.length && a.every((id, index) => b[index] === id);
}

/** The switched-on features, in catalogue order (stable reference between changes). */
export function getEnabledEasyFeatures(): readonly EasyFeatureId[] {
  return enabled;
}

export function isEasyFeatureEnabled(id: EasyFeatureId): boolean {
  return enabled.includes(id);
}

/** Switch one feature on or off, save it and update every screen at once. */
export function setEasyFeatureEnabled(id: EasyFeatureId, on: boolean): void {
  const next = EASY_FEATURE_IDS.filter((item) => (item === id ? on : enabled.includes(item)));
  try {
    globalThis.localStorage?.setItem(EASY_FEATURES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* Storage can be unavailable; the choice still applies to this session. */
  }
  if (sameList(next, enabled)) return;
  enabled = next;
  notify();
}

/** Re-read the saved list (another window changed it, or a test reset it). */
export function reloadEasyFeatures(): void {
  const next = readStored();
  if (sameList(next, enabled)) return;
  enabled = next;
  notify();
}

export function subscribeEasyFeatures(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === EASY_FEATURES_STORAGE_KEY) reloadEasyFeatures();
  });

/** Reactive list of switched-on features for components. */
export function useEasyFeatures(): readonly EasyFeatureId[] {
  return useSyncExternalStore(
    subscribeEasyFeatures,
    getEnabledEasyFeatures,
    getEnabledEasyFeatures,
  );
}

/** The feature a pathname belongs to, whether it is switched on or not. */
export function easyFeatureForPath(pathname: string): EasyFeatureId | null {
  const path = pathname.replace(/\/+$/, '');
  for (const id of EASY_FEATURE_IDS) {
    const base = EASY_FEATURE_PATHS[id];
    if (path === base || path.startsWith(`${base}/`)) return id;
  }
  return null;
}

/** True when `pathname` is the route of a switched-on feature. */
export function isEnabledEasyFeaturePath(
  pathname: string,
  features: readonly EasyFeatureId[] = enabled,
): boolean {
  const id = easyFeatureForPath(pathname);
  return id !== null && features.includes(id);
}
