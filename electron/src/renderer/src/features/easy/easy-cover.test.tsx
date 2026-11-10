import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '@/lib/api/types';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  profiles: { data: [] as unknown[], isLoading: false },
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  saveLocalFile: vi.fn(),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  Outlet: () => null,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/components/app-shell/app-shell', () => ({ AppShell: () => null }));
vi.mock('@/hooks/use-profiles', () => ({ useProfiles: () => mocks.profiles }));
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiJson: mocks.apiJson,
  apiFetch: mocks.apiFetch,
}));
vi.mock('@/lib/local-export', () => ({ saveLocalFile: mocks.saveLocalFile }));
vi.mock('@/components/bridge', () => ({ isMac: () => false, getBridge: () => null }));

import {
  EASY_FEATURES_STORAGE_KEY,
  reloadEasyFeatures,
  setEasyFeatureEnabled,
} from '@/lib/easy-features';
import { easyModeRedirect } from '@/lib/easy-mode';
import { EasyCoverPage } from './easy-cover-page';
import {
  coverClock,
  coverPitchLabel,
  currentCoverJob,
  dismissCoverJob,
  type CoverJob,
} from './easy-cover';
import { EASY_FEATURE_CATALOG } from './easy-feature-catalog';

function voice(id: string, name: string): Profile {
  return {
    id,
    name,
    kind: 'clone',
    ref_audio_path: `${id}.wav`,
    ref_text: 'hello',
    instruct: null,
    language: 'Auto',
    seed: null,
    personality: null,
    vd_states: null,
    created_at: 1_760_000_000,
    is_locked: false,
  };
}

function job(over: Partial<CoverJob> = {}): CoverJob {
  return {
    id: 'aaaaaaaaaaaa',
    state: 'running',
    step: 'converting',
    step_percent: 40,
    percent: 55,
    profile_id: 'v1',
    profile_name: 'Jinho',
    song_name: 'Anthem',
    semitones: 'auto',
    song_seconds: 40,
    error: null,
    error_code: null,
    created_at: 100,
    elapsed_s: 65,
    result: null,
    ...over,
  };
}

const READY = {
  ready: true,
  missing_bytes: 0,
  total_bytes: 2_535_323_336,
  install: { state: 'idle', error: null, percent: 0, downloaded_bytes: 0, total_bytes: 1 },
};

function routeApi(handlers: {
  jobs?: () => unknown;
  setup?: () => unknown;
  post?: (body: FormData) => unknown;
}) {
  mocks.apiJson.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/cover/setup' && !init?.method) return handlers.setup?.() ?? READY;
    if (path === '/cover/setup' && init?.method === 'POST') return handlers.setup?.() ?? READY;
    if (path === '/cover/jobs' && init?.method === 'POST')
      return handlers.post?.(init.body as FormData);
    if (path === '/cover/jobs') return handlers.jobs?.() ?? { jobs: [] };
    if (path.endsWith('/cancel')) return job({ state: 'cancelled' });
    throw new Error(`unexpected ${path}`);
  });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EasyCoverPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  mocks.profiles.data = [voice('v1', 'Jinho'), voice('v2', 'Mina')];
  mocks.apiJson.mockReset();
  dismissCoverJob('');
});

afterEach(() => cleanup());

describe('song cover feature switch', () => {
  it('is in the catalogue, off by default, and its route only opens when on', () => {
    const info = EASY_FEATURE_CATALOG.find((item) => item.id === 'cover');
    expect(info?.path).toBe('/easy/cover');
    expect(info?.nameKey).toBe('easy.feature_cover');
    localStorage.removeItem(EASY_FEATURES_STORAGE_KEY);
    reloadEasyFeatures();
    expect(easyModeRedirect('/easy/cover', true, [])).toBe('/');
    expect(easyModeRedirect('/easy/cover', true, ['cover'])).toBeNull();
    expect(easyModeRedirect('/easy/create', true, [])).toBeNull();
    expect(easyModeRedirect('/easy/cover', false, [])).toBeNull();
    setEasyFeatureEnabled('cover', true);
    expect(JSON.parse(localStorage.getItem(EASY_FEATURES_STORAGE_KEY) ?? '[]')).toContain('cover');
    setEasyFeatureEnabled('cover', false);
  });
});

describe('easy cover helpers', () => {
  it('formats clocks and pitch, and picks the job to show', () => {
    expect(coverClock(65)).toBe('1:05');
    expect(coverPitchLabel(-12)).toBe('-12');
    expect(coverPitchLabel(3)).toBe('+3');
    expect(coverPitchLabel(0)).toBe('0');
    const done = job({ id: 'bbbbbbbbbbbb', state: 'done' });
    expect(currentCoverJob([done], '')).toBe(done);
    expect(currentCoverJob([done], 'bbbbbbbbbbbb')).toBeNull();
    const running = job();
    expect(currentCoverJob([done, running], 'aaaaaaaaaaaa')).toBe(running);
  });
});

describe('EasyCoverPage', () => {
  it('offers the one-time download while the models are missing', async () => {
    routeApi({
      setup: () => ({ ...READY, ready: false, missing_bytes: 2_535_323_336 }),
    });
    renderPage();
    const button = await screen.findByRole('button', { name: /easy.cover_setup_button/ });
    expect(screen.getByRole('button', { name: /easy.cover_button/ })).toBeDisabled();
    fireEvent.click(button);
    await waitFor(() =>
      expect(mocks.apiJson).toHaveBeenCalledWith('/cover/setup', { method: 'POST' }),
    );
  });

  it('uploads the chosen song with the chosen voice and pitch', async () => {
    let posted: FormData | null = null;
    routeApi({
      post: (body) => {
        posted = body;
        return job({ state: 'queued', step: 'preparing', percent: 0, elapsed_s: 0 });
      },
    });
    renderPage();
    expect(screen.getByText('easy.cover_notice')).toBeInTheDocument();
    const make = await screen.findByRole('button', { name: /easy.cover_button/ });
    await waitFor(() => expect(screen.getByText('easy.cover_need_song')).toBeInTheDocument());
    expect(make).toBeDisabled();

    const file = new File([new Uint8Array(2048)], 'Anthem.mp3', { type: 'audio/mpeg' });
    fireEvent.change(screen.getByLabelText('easy.cover_pick_song'), { target: { files: [file] } });
    expect(await screen.findByText('Anthem.mp3')).toBeInTheDocument();

    const voices = screen.getByRole('radiogroup', { name: 'easy.cover_step_voice' });
    fireEvent.click(within(voices).getByRole('radio', { name: /Mina/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'easy.cover_pitch_manual' }));
    fireEvent.click(screen.getByRole('button', { name: 'easy.cover_pitch_down' }));
    fireEvent.click(screen.getByRole('button', { name: 'easy.cover_pitch_down' }));
    expect(screen.getByText('-2')).toBeInTheDocument();

    expect(make).toBeEnabled();
    fireEvent.click(make);
    await waitFor(() => expect(posted).not.toBeNull());
    const body = posted as unknown as FormData;
    expect(body.get('profile_id')).toBe('v2');
    expect(body.get('semitones')).toBe('-2');
    expect((body.get('audio') as File).name).toBe('Anthem.mp3');
  });

  it('rejects files over the upload limit before sending', async () => {
    routeApi({});
    renderPage();
    const big = new File(['x'], 'huge.wav', { type: 'audio/wav' });
    Object.defineProperty(big, 'size', { value: 300 * 1024 * 1024 });
    fireEvent.change(await screen.findByLabelText('easy.cover_pick_song'), {
      target: { files: [big] },
    });
    expect(await screen.findByText('easy.cover_err_too_large')).toBeInTheDocument();
  });

  it('shows a running job from the backend with its steps, and cancels it', async () => {
    routeApi({ jobs: () => ({ jobs: [job()] }) });
    renderPage();
    const progress = await screen.findByText('easy.cover_making');
    const panel = progress.closest('[data-slot="easy-cover-progress"]') as HTMLElement;
    expect(within(panel).getByText('55%')).toBeInTheDocument();
    const steps = panel.querySelectorAll('li');
    expect(Array.from(steps).map((li) => li.getAttribute('data-state'))).toEqual([
      'done',
      'done',
      'active',
      'waiting',
      'waiting',
    ]);
    expect(screen.queryByRole('button', { name: /easy.cover_button/ })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'easy.cancel' }));
    await waitFor(() =>
      expect(mocks.apiJson).toHaveBeenCalledWith('/cover/jobs/aaaaaaaaaaaa/cancel', {
        method: 'POST',
      }),
    );
  });

  it('shows the finished song with play, save and new-song actions', async () => {
    const done = job({
      state: 'done',
      step: 'saving',
      percent: 100,
      result: {
        id: 'take0001',
        audio_path: 'take0001.wav',
        audio_url: '/audio/take0001.wav',
        duration_s: 40,
        semitones: -12,
        has_instrumental: true,
      },
    });
    routeApi({ jobs: () => ({ jobs: [done] }) });
    renderPage();
    const result = await screen.findByLabelText('easy.cover_done');
    expect(within(result).getByRole('button', { name: /easy.play/ })).toBeInTheDocument();
    expect(within(result).getByRole('button', { name: /easy.save_file/ })).toBeInTheDocument();
    expect(
      within(result).getByRole('button', { name: /easy.cover_save_instrumental/ }),
    ).toBeInTheDocument();
    fireEvent.click(within(result).getByRole('button', { name: /easy.cover_new/ }));
    expect(await screen.findByRole('button', { name: /easy.cover_button/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('easy.cover_done')).toBeNull();
  });

  it('explains a failed job in plain words', async () => {
    routeApi({
      jobs: () => ({ jobs: [job({ state: 'error', error_code: 'interrupted', error: 'x' })] }),
    });
    renderPage();
    expect(await screen.findByText('easy.cover_failed')).toBeInTheDocument();
    expect(screen.getByText('easy.cover_err_interrupted')).toBeInTheDocument();
  });
});
