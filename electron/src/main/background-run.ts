import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, ipcMain, Notification, type BrowserWindow, type Tray } from 'electron';
import { assertTrustedMainFrame } from './ipc';
import { renameWithRetry } from './rename-retry';
import {
  assertBackgroundPatch,
  assertNoticeLabels,
  FALLBACK_NOTICE_LABELS,
  HIDDEN_LAUNCH_ARG,
  parseBackgroundPrefs,
  supportsCloseToTray,
  supportsOpenAtLogin,
  type BackgroundNoticeLabels,
  type BackgroundPrefs,
} from './close-to-tray';

export const BACKGROUND_CHANNELS = {
  get: 'app:background:get',
  set: 'app:background:set',
  labels: 'app:background:labels',
} as const;

export interface BackgroundState {
  closeToTray: boolean;
  openAtLogin: boolean;
  closeToTraySupported: boolean;
  openAtLoginSupported: boolean;
}

export interface BackgroundRun {
  /** The user wants X to hide the window to the tray. */
  closeToTray(): boolean;
  /** Called after the window was hidden; shows the one-time tray notice. */
  hidden(): void;
  dispose(): void;
}

/** Settings-backed "keep running in the notification area" wiring (Windows/Linux). */
export function installBackgroundRun(
  getMainWindow: () => BrowserWindow | null,
  getTray: () => Tray | null,
): BackgroundRun {
  const platform = process.platform;
  const file = join(app.getPath('userData'), 'background-run.json');
  let prefs: BackgroundPrefs;
  try {
    prefs = parseBackgroundPrefs(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    prefs = parseBackgroundPrefs(null);
  }
  let labels: BackgroundNoticeLabels = FALLBACK_NOTICE_LABELS;
  let writing: Promise<void> = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify(prefs);
    writing = writing
      .catch(() => {})
      .then(async () => {
        const temporary = file + '.tmp';
        await writeFile(temporary, snapshot, 'utf8');
        await renameWithRetry(temporary, file);
      });
    return writing;
  };
  // Dev launches run electron.exe with the app directory as its first argument.
  const loginArgs = app.isPackaged ? [HIDDEN_LAUNCH_ARG] : [app.getAppPath(), HIDDEN_LAUNCH_ARG];
  const state = (): BackgroundState => ({
    closeToTray: prefs.closeToTray,
    openAtLogin: supportsOpenAtLogin(platform)
      ? app.getLoginItemSettings({ args: loginArgs }).openAtLogin
      : false,
    closeToTraySupported: supportsCloseToTray(platform),
    openAtLoginSupported: supportsOpenAtLogin(platform),
  });

  ipcMain.handle(BACKGROUND_CHANNELS.get, (event) => {
    assertTrustedMainFrame(event, getMainWindow());
    return state();
  });
  ipcMain.handle(BACKGROUND_CHANNELS.set, async (event, raw: unknown) => {
    assertTrustedMainFrame(event, getMainWindow());
    const patch = assertBackgroundPatch(raw);
    if (patch.closeToTray !== undefined && supportsCloseToTray(platform)) {
      prefs = { ...prefs, closeToTray: patch.closeToTray };
      await persist();
    }
    if (patch.openAtLogin !== undefined && supportsOpenAtLogin(platform)) {
      app.setLoginItemSettings({ openAtLogin: patch.openAtLogin, args: loginArgs });
    }
    return state();
  });
  ipcMain.handle(BACKGROUND_CHANNELS.labels, (event, raw: unknown) => {
    assertTrustedMainFrame(event, getMainWindow());
    labels = assertNoticeLabels(raw);
  });

  return {
    closeToTray: () => supportsCloseToTray(platform) && prefs.closeToTray,
    hidden: () => {
      if (prefs.noticeShown) return;
      prefs = { ...prefs, noticeShown: true };
      void persist().catch(() => {});
      try {
        const tray = getTray();
        if (platform === 'win32' && tray && !tray.isDestroyed()) {
          tray.displayBalloon({ title: labels.title, content: labels.body, iconType: 'info' });
        } else if (Notification.isSupported()) {
          new Notification({ title: labels.title, body: labels.body }).show();
        }
      } catch {
        /* the notice is a courtesy; hiding already succeeded */
      }
    },
    dispose: () => {
      for (const channel of Object.values(BACKGROUND_CHANNELS)) ipcMain.removeHandler(channel);
    },
  };
}
