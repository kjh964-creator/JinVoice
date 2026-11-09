import { describe, expect, it } from 'vitest';
import {
  assertBackgroundPatch,
  assertNoticeLabels,
  DEFAULT_BACKGROUND_PREFS,
  decideCloseAction,
  isHiddenLaunch,
  parseBackgroundPrefs,
  supportsCloseToTray,
  supportsOpenAtLogin,
  type CloseContext,
} from './close-to-tray';

const base: CloseContext = {
  platform: 'win32',
  quitting: false,
  sessionEnding: false,
  closeToTray: true,
  trayAvailable: true,
};

describe('decideCloseAction', () => {
  it('hides to the tray on Windows and Linux when enabled', () => {
    expect(decideCloseAction(base)).toBe('hide');
    expect(decideCloseAction({ ...base, platform: 'linux' })).toBe('hide');
  });

  it('lets a real quit (tray exit, updater install) close the window', () => {
    expect(decideCloseAction({ ...base, quitting: true })).toBe('allow');
    expect(decideCloseAction({ ...base, platform: 'darwin', quitting: true })).toBe('allow');
  });

  it('quits on logoff/shutdown even when close-to-tray is on', () => {
    expect(decideCloseAction({ ...base, sessionEnding: true })).toBe('quit');
  });

  it('quits when the user turned the switch off or no tray exists', () => {
    expect(decideCloseAction({ ...base, closeToTray: false })).toBe('quit');
    expect(decideCloseAction({ ...base, trayAvailable: false })).toBe('quit');
  });

  it('keeps the macOS flush-and-destroy behaviour', () => {
    expect(decideCloseAction({ ...base, platform: 'darwin' })).toBe('flush-destroy');
    expect(decideCloseAction({ ...base, platform: 'darwin', closeToTray: false })).toBe(
      'flush-destroy',
    );
  });
});

it('limits platform support', () => {
  expect(supportsCloseToTray('win32')).toBe(true);
  expect(supportsCloseToTray('linux')).toBe(true);
  expect(supportsCloseToTray('darwin')).toBe(false);
  expect(supportsOpenAtLogin('win32')).toBe(true);
  expect(supportsOpenAtLogin('linux')).toBe(false);
  expect(supportsOpenAtLogin('darwin')).toBe(false);
});

it('detects the login-item hidden launch', () => {
  expect(isHiddenLaunch(['JinVoice.exe', '--hidden'])).toBe(true);
  expect(isHiddenLaunch(['JinVoice.exe'])).toBe(false);
  expect(isHiddenLaunch(['JinVoice.exe', '--hidden=false'])).toBe(false);
});

describe('parseBackgroundPrefs', () => {
  it('defaults to close-to-tray on and notice not yet shown', () => {
    expect(DEFAULT_BACKGROUND_PREFS).toEqual({ closeToTray: true, noticeShown: false });
    expect(parseBackgroundPrefs(null)).toEqual(DEFAULT_BACKGROUND_PREFS);
    expect(parseBackgroundPrefs([])).toEqual(DEFAULT_BACKGROUND_PREFS);
    expect(parseBackgroundPrefs({ closeToTray: 'no', noticeShown: 1 })).toEqual(
      DEFAULT_BACKGROUND_PREFS,
    );
  });

  it('keeps valid stored values', () => {
    expect(parseBackgroundPrefs({ closeToTray: false, noticeShown: true })).toEqual({
      closeToTray: false,
      noticeShown: true,
    });
  });
});

describe('assertBackgroundPatch', () => {
  it('accepts boolean switches', () => {
    expect(assertBackgroundPatch({ closeToTray: false })).toEqual({ closeToTray: false });
    expect(assertBackgroundPatch({ openAtLogin: true, closeToTray: true })).toEqual({
      openAtLogin: true,
      closeToTray: true,
    });
  });

  it.each([
    null,
    'on',
    [],
    {},
    { closeToTray: 'true' },
    { openAtLogin: 1 },
    { closeToTray: true, noticeShown: false },
    { path: 'C:/evil.exe' },
  ])('rejects %j', (raw) => {
    expect(() => assertBackgroundPatch(raw)).toThrow('Invalid background settings');
  });
});

describe('assertNoticeLabels', () => {
  it('accepts short localized text', () => {
    expect(assertNoticeLabels({ title: 'a', body: 'b' })).toEqual({ title: 'a', body: 'b' });
  });

  it.each([null, {}, { title: '', body: 'b' }, { title: 'a', body: 2 }, { title: 'a', body: 'x'.repeat(401) }])(
    'rejects %j',
    (raw) => {
      expect(() => assertNoticeLabels(raw)).toThrow('Invalid labels');
    },
  );
});
