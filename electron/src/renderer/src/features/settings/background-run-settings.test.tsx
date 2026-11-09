import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { BackgroundRunSettings } from './background-run-settings';

type State = {
  closeToTray: boolean;
  openAtLogin: boolean;
  closeToTraySupported: boolean;
  openAtLoginSupported: boolean;
};

function installBridge(platform: string, initial: State | undefined) {
  let state = initial;
  const set = vi.fn(async (patch: Partial<State>) => {
    state = { ...state!, ...patch };
    return state;
  });
  Object.defineProperty(window, 'voicestudio', {
    configurable: true,
    value: {
      app: {
        platform,
        background: initial ? { get: async () => state, set, labels: async () => {} } : undefined,
      },
    },
  });
  return set;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'voicestudio');
});

const windowsDefaults: State = {
  closeToTray: true,
  openAtLogin: false,
  closeToTraySupported: true,
  openAtLoginSupported: true,
};

it('shows both switches on Windows with close-to-tray on and autostart off', async () => {
  const set = installBridge('win32', windowsDefaults);
  render(<BackgroundRunSettings />);
  const close = await screen.findByRole('switch', { name: 'backgroundRun.close_to_tray' });
  const login = screen.getByRole('switch', { name: 'backgroundRun.open_at_login' });
  expect(close).toHaveAttribute('aria-checked', 'true');
  expect(login).toHaveAttribute('aria-checked', 'false');

  fireEvent.click(login);
  await waitFor(() => expect(set).toHaveBeenCalledWith({ openAtLogin: true }));
  await waitFor(() => expect(login).toHaveAttribute('aria-checked', 'true'));

  fireEvent.click(close);
  await waitFor(() => expect(set).toHaveBeenCalledWith({ closeToTray: false }));
  await waitFor(() => expect(close).toHaveAttribute('aria-checked', 'false'));
});

it('hides the autostart switch where login items are unsupported (Linux)', async () => {
  installBridge('linux', { ...windowsDefaults, openAtLoginSupported: false });
  render(<BackgroundRunSettings />);
  await screen.findByRole('switch', { name: 'backgroundRun.close_to_tray' });
  expect(screen.queryByRole('switch', { name: 'backgroundRun.open_at_login' })).toBeNull();
});

it('renders nothing on macOS or without the desktop bridge', async () => {
  installBridge('darwin', windowsDefaults);
  const mac = render(<BackgroundRunSettings />);
  await Promise.resolve();
  expect(mac.container).toBeEmptyDOMElement();
  mac.unmount();
  Reflect.deleteProperty(window, 'voicestudio');
  const web = render(<BackgroundRunSettings />);
  expect(web.container).toBeEmptyDOMElement();
});

it('reverts the switch when saving fails', async () => {
  installBridge('win32', windowsDefaults);
  const bridge = (window as unknown as { voicestudio: { app: { background: { set: unknown } } } })
    .voicestudio.app.background;
  bridge.set = vi.fn(async () => {
    throw new Error('disk full');
  });
  render(<BackgroundRunSettings />);
  const close = await screen.findByRole('switch', { name: 'backgroundRun.close_to_tray' });
  fireEvent.click(close);
  await waitFor(() => expect(close).toHaveAttribute('aria-checked', 'true'));
  expect(bridge.set).toHaveBeenCalledWith({ closeToTray: false });
});
