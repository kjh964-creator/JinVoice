import { useSyncExternalStore } from 'react';
import {
  getEnabledEasyFeatures,
  isEnabledEasyFeaturePath,
  type EasyFeatureId,
} from './easy-features';

/**
 * JinVoice easy mode: the app shows a few plain screens (make speech, my
 * voices, made speech, long text, help) plus Settings. Every other workspace
 * stays in the code base; it is only hidden while easy mode is on.
 *
 * Easy mode is a saved preference, on by default. Settings → General →
 * "Show all features (advanced)" turns it off and brings back the full
 * VoiceStudio workspace at once; the full UI has a "Back to easy screen"
 * button that turns it on again. One source of truth: `isEasyModeEnabled()`
 * for plain code (route guards) and `useEasyMode()` for components.
 */
export const EASY_MODE_STORAGE_KEY = 'jinvoice.easy-mode.v1';

function readStored(): boolean {
  try {
    // Only an explicit "0" (the user chose the full UI) turns easy mode off.
    return globalThis.localStorage?.getItem(EASY_MODE_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

let enabled = readStored();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Current mode, for code outside React (route `beforeLoad`, callbacks). */
export function isEasyModeEnabled(): boolean {
  return enabled;
}

/** Save the mode and update every screen at once (no restart). */
export function setEasyModeEnabled(next: boolean): void {
  try {
    globalThis.localStorage?.setItem(EASY_MODE_STORAGE_KEY, next ? '1' : '0');
  } catch {
    /* Storage can be unavailable; the choice still applies to this session. */
  }
  if (next === enabled) return;
  enabled = next;
  notify();
}

/** Re-read the saved value (another window changed it, or a test reset it). */
export function reloadEasyModePreference(): void {
  const next = readStored();
  if (next === enabled) return;
  enabled = next;
  notify();
}

export function subscribeEasyMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === EASY_MODE_STORAGE_KEY) reloadEasyModePreference();
  });

/** Reactive easy-mode flag for components. */
export function useEasyMode(): boolean {
  return useSyncExternalStore(subscribeEasyMode, isEasyModeEnabled, isEasyModeEnabled);
}

export const EASY_ROUTES = {
  home: '/',
  create: '/easy/create',
  voices: '/easy/voices',
  newVoice: '/easy/voices/new',
  history: '/easy/history',
  audiobook: '/easy/audiobook',
  help: '/easy/help',
  features: '/easy/features',
} as const;

/**
 * Settings pages easy mode hides: upstream's donation/support-plan page and
 * the VoiceStudio Cloud account page (sign-in, sync, Pro). The full UI shows
 * them exactly as upstream does.
 */
const EASY_HIDDEN_SETTINGS = ['/settings/support', '/settings/account'];

/** Routes easy mode shows; anything else is sent back to the easy home. */
export function isEasyModePath(pathname: string): boolean {
  if (
    EASY_HIDDEN_SETTINGS.some((hidden) => pathname === hidden || pathname.startsWith(`${hidden}/`))
  )
    return false;
  return (
    pathname === '/' ||
    pathname === '' ||
    pathname === '/easy' ||
    pathname.startsWith('/easy/') ||
    pathname === '/settings' ||
    pathname.startsWith('/settings/')
  );
}

/**
 * Where the root route guard sends `pathname`, or null to let it through.
 * Easy mode also lets through the original workspaces the user switched on
 * one by one (Settings → General → "Turn features on and off").
 */
export function easyModeRedirect(
  pathname: string,
  easy = isEasyModeEnabled(),
  features: readonly EasyFeatureId[] = getEnabledEasyFeatures(),
): string | null {
  if (!easy || isEasyModePath(pathname)) return null;
  return isEnabledEasyFeaturePath(pathname, features) ? null : '/';
}
