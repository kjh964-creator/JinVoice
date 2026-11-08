import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  pathname: '/',
}));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mocks.navigate,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: mocks.pathname } }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  Outlet: () => <div data-testid="outlet" />,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/hooks/use-profiles', () => ({ useProfiles: () => ({ data: [], isLoading: false }) }));
vi.mock('@/hooks/use-history', () => ({ useHistory: () => ({ data: [], isLoading: false }) }));
vi.mock('@/hooks/use-backend-status', () => ({ useBackendStatus: () => ({ stage: 'ready' }) }));
vi.mock('@/components/bridge', () => ({ isMac: () => false, getBridge: () => null }));
vi.mock('@/components/backend-gate', () => ({
  BackendGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/app-shell/repair-agent-dock', () => ({ RepairAgentDock: () => null }));
vi.mock('@/components/app-shell/context-sidebar', () => ({ ContextSidebar: () => null }));
vi.mock('@/components/app-shell/workspace-sidebar', () => ({
  WorkspaceSidebar: () => <nav data-testid="full-sidebar" />,
}));
vi.mock('@/components/app-shell/sidebar-toggle', () => ({ SidebarToggle: () => null }));
vi.mock('@/components/app-shell/support-shortcut', () => ({
  SupportShortcut: () => <a data-testid="pro-shortcut" />,
}));
vi.mock('@/components/app-shell/account-corner', () => ({ AccountCorner: () => null }));
vi.mock('@/components/command-palette', () => ({ CommandPalette: () => null }));
vi.mock('@/components/now-playing-dock', () => ({ NowPlayingDock: () => null }));
vi.mock('@/features/easy/easy-web-session', () => ({ EasyWebSession: () => null }));

import { AppShell } from '@/components/app-shell/app-shell';
import { WorkspaceHeader } from '@/components/app-shell/workspace-header';
import {
  EASY_FEATURES_STORAGE_KEY,
  EASY_FEATURE_IDS,
  easyFeatureForPath,
  getEnabledEasyFeatures,
  isEasyFeatureEnabled,
  reloadEasyFeatures,
  setEasyFeatureEnabled,
} from '@/lib/easy-features';
import { easyModeRedirect, reloadEasyModePreference, setEasyModeEnabled } from '@/lib/easy-mode';
import { rootRoute } from '@/routes/index';
import { EasyFeatureSettings } from './easy-feature-settings';
import { EASY_FEATURE_CATALOG } from './easy-feature-catalog';
import { EasyFeaturesPage } from './easy-features-page';
import { EasyHomePage } from './easy-home-page';

function guard(pathname: string): string | null {
  try {
    (rootRoute.options.beforeLoad as (ctx: unknown) => void)({ location: { pathname } });
    return null;
  } catch (error) {
    const target = error as { options?: { to?: string }; to?: string };
    return target.options?.to ?? target.to ?? 'redirect';
  }
}

beforeEach(() => {
  localStorage.clear();
  reloadEasyModePreference();
  reloadEasyFeatures();
  mocks.pathname = '/';
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  reloadEasyFeatures();
  setEasyModeEnabled(true);
});

describe('easy feature switches store', () => {
  it('starts with every feature off', () => {
    expect(getEnabledEasyFeatures()).toEqual([]);
    for (const id of EASY_FEATURE_IDS) expect(isEasyFeatureEnabled(id)).toBe(false);
  });

  it('saves each switch and reads it back in catalogue order', () => {
    setEasyFeatureEnabled('dub', true);
    setEasyFeatureEnabled('clone', true);
    expect(getEnabledEasyFeatures()).toEqual(['clone', 'dub']);
    expect(JSON.parse(localStorage.getItem(EASY_FEATURES_STORAGE_KEY)!)).toEqual(['clone', 'dub']);
    setEasyFeatureEnabled('clone', false);
    reloadEasyFeatures();
    expect(getEnabledEasyFeatures()).toEqual(['dub']);
  });

  it('ignores broken or unknown saved values', () => {
    localStorage.setItem(EASY_FEATURES_STORAGE_KEY, '{not json');
    reloadEasyFeatures();
    expect(getEnabledEasyFeatures()).toEqual([]);
    localStorage.setItem(EASY_FEATURES_STORAGE_KEY, JSON.stringify(['tools', 'pro', 7, 'tools']));
    reloadEasyFeatures();
    expect(getEnabledEasyFeatures()).toEqual(['tools']);
  });

  it('follows another window through the storage event', () => {
    localStorage.setItem(EASY_FEATURES_STORAGE_KEY, JSON.stringify(['gallery']));
    window.dispatchEvent(new StorageEvent('storage', { key: EASY_FEATURES_STORAGE_KEY }));
    expect(getEnabledEasyFeatures()).toEqual(['gallery']);
  });

  it('maps routes and sub-routes to their feature', () => {
    expect(easyFeatureForPath('/integrations/n8n')).toBe('integrations');
    expect(easyFeatureForPath('/dub/')).toBe('dub');
    expect(easyFeatureForPath('/dubbing')).toBeNull();
    expect(easyFeatureForPath('/pro')).toBeNull();
  });
});

describe('easy mode route guard with feature switches', () => {
  it('blocks OFF features and lets ON features through', () => {
    expect(guard('/dub')).toBe('/');
    expect(guard('/integrations/n8n')).toBe('/');
    setEasyFeatureEnabled('dub', true);
    setEasyFeatureEnabled('integrations', true);
    expect(guard('/dub')).toBeNull();
    expect(guard('/integrations/n8n')).toBeNull();
    // Everything else stays hidden, including upstream's paid/support pages.
    expect(guard('/batch')).toBe('/');
    expect(guard('/pro')).toBe('/');
    expect(guard('/settings/support')).toBe('/');
    setEasyFeatureEnabled('dub', false);
    expect(guard('/dub')).toBe('/');
  });

  it('keeps the easy feature-switch screen open in easy mode', () => {
    expect(guard('/easy/features')).toBeNull();
  });

  it('never redirects in the full UI, whatever the switches say', () => {
    expect(easyModeRedirect('/batch', false, [])).toBeNull();
    expect(easyModeRedirect('/batch', true, ['batch'])).toBeNull();
    expect(easyModeRedirect('/batch', true, ['dub'])).toBe('/');
  });
});

describe('Settings feature list', () => {
  it('lists every feature as off, and a switch turns one on and off', () => {
    render(<EasyFeatureSettings />);
    const rows = document.querySelectorAll('[data-slot="easy-feature-row"]');
    expect(rows).toHaveLength(EASY_FEATURE_CATALOG.length);
    expect(screen.getAllByText('easy.feature_off')).toHaveLength(EASY_FEATURE_CATALOG.length);
    expect(screen.queryByRole('note')).not.toBeInTheDocument();

    const row = document.querySelector<HTMLElement>('[data-feature="dub"]')!;
    const toggle = within(row).getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    expect(isEasyFeatureEnabled('dub')).toBe(true);
    expect(within(row).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(within(row).getByText('easy.feature_on')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(EASY_FEATURES_STORAGE_KEY)!)).toEqual(['dub']);

    fireEvent.click(within(row).getByRole('switch'));
    expect(isEasyFeatureEnabled('dub')).toBe(false);
  });

  it('says everything is visible while the full UI is shown', () => {
    act(() => setEasyModeEnabled(false));
    render(<EasyFeatureSettings />);
    expect(screen.getByRole('note')).toHaveTextContent('easy.features_all_visible');
    // The list stays editable for when the user goes back to the easy screen.
    expect(screen.getAllByRole('switch')[0]).not.toHaveAttribute('aria-disabled', 'true');
  });
});

describe('easy feature-switch screen', () => {
  it('shows the same switches as an easy page', () => {
    render(<EasyFeaturesPage />);
    expect(screen.getByRole('heading', { name: 'easy.features_title' })).toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(EASY_FEATURE_CATALOG.length);
    fireEvent.click(
      within(document.querySelector<HTMLElement>('[data-feature="tools"]')!).getByRole('switch'),
    );
    expect(isEasyFeatureEnabled('tools')).toBe(true);
  });
});

describe('easy home extra features', () => {
  it('shows no extra cards while every feature is off, only a quiet link', () => {
    render(<EasyHomePage />);
    expect(document.querySelectorAll('[data-slot="easy-extra-card"]')).toHaveLength(0);
    expect(screen.queryByText('easy.extra_title')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /easy\.features_more/ }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/easy/features' });
  });

  it('shows exactly the switched-on features and opens their route', () => {
    setEasyFeatureEnabled('transcriptions', true);
    setEasyFeatureEnabled('design', true);
    render(<EasyHomePage />);
    expect(screen.getByText('easy.extra_title')).toBeInTheDocument();
    const cards = [...document.querySelectorAll<HTMLElement>('[data-slot="easy-extra-card"]')];
    expect(cards.map((card) => card.dataset.feature)).toEqual(['design', 'transcriptions']);
    fireEvent.click(cards[1]!);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/transcriptions' });
    // The four main cards are unchanged.
    expect(document.querySelectorAll('[data-slot="easy-home-card"]')).toHaveLength(4);
  });

  it('updates live when a switch changes', () => {
    render(<EasyHomePage />);
    act(() => setEasyFeatureEnabled('gallery', true));
    expect(document.querySelector('[data-feature="gallery"]')).toBeInTheDocument();
    act(() => setEasyFeatureEnabled('gallery', false));
    expect(document.querySelector('[data-feature="gallery"]')).not.toBeInTheDocument();
  });
});

describe('switched-on feature inside easy mode', () => {
  it('opens under the easy bar with a way home, without leaving easy mode', () => {
    setEasyFeatureEnabled('dub', true);
    mocks.pathname = '/dub';
    render(<AppShell />);
    expect(document.querySelector('[data-slot="easy-feature-frame"]')).toBeInTheDocument();
    expect(screen.getByTestId('outlet')).toBeInTheDocument();
    expect(screen.queryByTestId('full-sidebar')).not.toBeInTheDocument();
    const back = screen.getByRole('button', { name: /easy\.back_home/ });
    fireEvent.click(back);
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/' });
    expect(localStorage.getItem('jinvoice.easy-mode.v1')).not.toBe('0');
  });

  it('drops the page header’s duplicate way back and Pro shortcut in easy mode only', () => {
    const { unmount } = render(<WorkspaceHeader>page</WorkspaceHeader>);
    expect(document.querySelector('[data-slot="easy-mode-return"]')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pro-shortcut')).not.toBeInTheDocument();
    unmount();
    act(() => setEasyModeEnabled(false));
    render(<WorkspaceHeader>page</WorkspaceHeader>);
    expect(document.querySelector('[data-slot="easy-mode-return"]')).toBeInTheDocument();
    expect(screen.getByTestId('pro-shortcut')).toBeInTheDocument();
  });

  it('keeps the plain easy frame for easy screens', () => {
    mocks.pathname = '/easy/create';
    render(<AppShell />);
    expect(document.querySelector('[data-slot="easy-feature-frame"]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="easy-shell"]')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /easy\.back_home/ })).not.toBeInTheDocument();
  });
});
