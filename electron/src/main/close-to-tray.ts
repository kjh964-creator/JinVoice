/**
 * Pure decisions for "keep running in the notification area" (Windows/Linux).
 * Electron wiring lives in background-run.ts; everything here is testable
 * without a window.
 */

/** Launch argument the login item passes so a boot start stays tray-only. */
export const HIDDEN_LAUNCH_ARG = '--hidden';

export type CloseAction =
  /** A real quit is already in progress — let the window close. */
  | 'allow'
  /** Keep the app (and backend) running; just hide the window. */
  | 'hide'
  /** macOS: flush renderer persistence, then destroy the window (app stays). */
  | 'flush-destroy'
  /** Start the orderly quit (flush, tear down backend, exit). */
  | 'quit';

export interface CloseContext {
  platform: NodeJS.Platform;
  /** A real quit (tray exit, app menu Quit, updater install) already began. */
  quitting: boolean;
  /** Windows is logging off / shutting down. */
  sessionEnding: boolean;
  /** The user's "close (X) hides to the tray" preference. */
  closeToTray: boolean;
  /** A tray icon exists, so a hidden window can be reopened. */
  trayAvailable: boolean;
}

export function decideCloseAction(ctx: CloseContext): CloseAction {
  if (ctx.quitting) return 'allow';
  if (ctx.platform === 'darwin') return 'flush-destroy';
  if (ctx.sessionEnding) return 'quit';
  if (ctx.closeToTray && ctx.trayAvailable) return 'hide';
  return 'quit';
}

/** Close-to-tray applies to Windows and Linux; macOS keeps its dock behaviour. */
export function supportsCloseToTray(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'linux';
}

/** Electron's login items are implemented for Windows (and macOS, which we leave alone). */
export function supportsOpenAtLogin(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

export function isHiddenLaunch(argv: readonly string[]): boolean {
  return argv.includes(HIDDEN_LAUNCH_ARG);
}

export interface BackgroundPrefs {
  closeToTray: boolean;
  /** The one-time "still running in the tray" notice was already shown. */
  noticeShown: boolean;
}

export const DEFAULT_BACKGROUND_PREFS: BackgroundPrefs = {
  closeToTray: true,
  noticeShown: false,
};

/** Tolerant reader for the userData JSON: anything malformed falls back to defaults. */
export function parseBackgroundPrefs(raw: unknown): BackgroundPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_BACKGROUND_PREFS };
  const value = raw as Record<string, unknown>;
  return {
    closeToTray:
      typeof value.closeToTray === 'boolean'
        ? value.closeToTray
        : DEFAULT_BACKGROUND_PREFS.closeToTray,
    noticeShown:
      typeof value.noticeShown === 'boolean'
        ? value.noticeShown
        : DEFAULT_BACKGROUND_PREFS.noticeShown,
  };
}

export interface BackgroundPatch {
  closeToTray?: boolean;
  openAtLogin?: boolean;
}

/** Strict validator for the renderer's settings IPC. */
export function assertBackgroundPatch(raw: unknown): BackgroundPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid background settings');
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => key !== 'closeToTray' && key !== 'openAtLogin'))
    throw new Error('Invalid background settings');
  const patch: BackgroundPatch = {};
  for (const key of keys as (keyof BackgroundPatch)[]) {
    if (typeof value[key] !== 'boolean') throw new Error('Invalid background settings');
    patch[key] = value[key] as boolean;
  }
  return patch;
}

export interface BackgroundNoticeLabels {
  title: string;
  body: string;
}

/** Fallback when the renderer has not delivered its localized labels yet. */
export const FALLBACK_NOTICE_LABELS: BackgroundNoticeLabels = {
  title: 'JinVoice is still running',
  body: 'JinVoice keeps running from the icon in the notification area. To quit completely, right-click the icon and choose Quit.',
};

export function assertNoticeLabels(raw: unknown): BackgroundNoticeLabels {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid labels');
  const { title, body } = raw as Record<string, unknown>;
  if (
    typeof title !== 'string' ||
    typeof body !== 'string' ||
    !title.trim() ||
    !body.trim() ||
    title.length > 120 ||
    body.length > 400
  )
    throw new Error('Invalid labels');
  return { title, body };
}
