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
import { EASY_FEATURE_CATALOG } from './easy-feature-catalog';
import { EasyStorySongPage } from './easy-story-song-page';
import {
  STORY_DRAFT_KEY,
  currentStoryJob,
  loadStoryDraft,
  saveStoryLyrics,
  storyLyricLines,
  storySongFileName,
  type StorySongJob,
} from './easy-story-song';

const STORY = 'Last summer our family went to the sea and sang all the way.';
const LYRICS = '[verse]\nline one\nline two\n\n[chorus]\nhook line';

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

function job(over: Partial<StorySongJob> = {}): StorySongJob {
  return {
    id: 'aaaaaaaaaaaa',
    state: 'running',
    step: 'composing',
    step_percent: 40,
    percent: 17,
    profile_id: 'v1',
    profile_name: 'Jinho',
    title: 'Sea Night',
    lyrics: LYRICS,
    genre: 'ballad',
    length: '1',
    song_seconds: null,
    error: null,
    error_code: null,
    created_at: 100,
    elapsed_s: 65,
    result: null,
    ...over,
  };
}

const READY = {
  supported: true,
  ready: true,
  missing_bytes: 0,
  total_bytes: 11_340_048_134,
  install: { state: 'idle', error: null, percent: 0, downloaded_bytes: 0, total_bytes: 1 },
};

function routeApi(handlers: {
  jobs?: () => unknown;
  setup?: () => unknown;
  lyrics?: (body: unknown) => unknown;
  lyricsTask?: () => unknown;
  song?: (body: unknown) => unknown;
}) {
  mocks.apiJson.mockImplementation(async (path: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (path === '/story-song/setup') return handlers.setup?.() ?? READY;
    if (path === '/story-song/lyrics' && init?.method === 'POST') return handlers.lyrics?.(body);
    if (path.startsWith('/story-song/lyrics/') && path.endsWith('/cancel'))
      return { id: 'bbbbbbbbbbbb', state: 'cancelled' };
    if (path.startsWith('/story-song/lyrics/')) return handlers.lyricsTask?.();
    if (path === '/story-song/jobs' && init?.method === 'POST') return handlers.song?.(body);
    if (path === '/story-song/jobs') return handlers.jobs?.() ?? { jobs: [] };
    if (path.endsWith('/cancel')) return job({ state: 'cancelled' });
    throw new Error(`unexpected ${path}`);
  });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EasyStorySongPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  mocks.profiles.data = [voice('v1', 'Jinho'), voice('v2', 'Mina')];
  mocks.apiJson.mockReset();
  mocks.saveLocalFile.mockReset();
});

afterEach(() => cleanup());

describe('song from a story feature switch', () => {
  it('is in the catalogue, off by default, and its route only opens when on', () => {
    const info = EASY_FEATURE_CATALOG.find((item) => item.id === 'story_song');
    expect(info?.path).toBe('/easy/story-song');
    expect(info?.nameKey).toBe('easy.feature_story_song');
    localStorage.removeItem(EASY_FEATURES_STORAGE_KEY);
    reloadEasyFeatures();
    expect(easyModeRedirect('/easy/story-song', true, [])).toBe('/');
    expect(easyModeRedirect('/easy/story-song', true, ['story_song'])).toBeNull();
    expect(easyModeRedirect('/easy/story-song', true, ['cover'])).toBe('/');
    setEasyFeatureEnabled('story_song', true);
    expect(JSON.parse(localStorage.getItem(EASY_FEATURES_STORAGE_KEY) ?? '[]')).toContain(
      'story_song',
    );
    setEasyFeatureEnabled('story_song', false);
  });
});

describe('story song helpers', () => {
  it('counts lyric lines, names files, picks the job and reads a damaged draft safely', () => {
    expect(storyLyricLines(LYRICS)).toBe(3);
    expect(storySongFileName(job(), false)).toBe('Sea Night - Jinho.wav');
    expect(storySongFileName(job(), true)).toBe('Sea Night - AI.wav');
    const done = job({ id: 'bbbbbbbbbbbb', state: 'done' });
    expect(currentStoryJob([done], '')).toBe(done);
    expect(currentStoryJob([done], 'bbbbbbbbbbbb')).toBeNull();
    const running = job();
    expect(currentStoryJob([done, running], 'aaaaaaaaaaaa')).toBe(running);
    localStorage.setItem(STORY_DRAFT_KEY, '{"genre":"metal","length":"9","story":42');
    expect(loadStoryDraft().genre).toBe('ballad');
    localStorage.setItem(STORY_DRAFT_KEY, JSON.stringify({ genre: 'metal', length: '3' }));
    expect(loadStoryDraft()).toMatchObject({ genre: 'ballad', length: '3', phase: 'story' });
  });

  it('saves the lyrics as a text file', async () => {
    mocks.saveLocalFile.mockResolvedValue({ canceled: false });
    await saveStoryLyrics(job());
    const [blob, name] = mocks.saveLocalFile.mock.calls[0] as [Blob, string];
    expect(name).toBe('Sea Night.txt');
    expect(await blob.text()).toBe(`Sea Night\n\n${LYRICS}\n`);
  });
});

describe('EasyStorySongPage', () => {
  it('offers the one-time download while the files are missing', async () => {
    routeApi({ setup: () => ({ ...READY, ready: false, missing_bytes: 8_804_000_000 }) });
    renderPage();
    const button = await screen.findByRole('button', { name: /easy.cover_setup_button/ });
    expect(screen.getByRole('button', { name: /easy.story_write_button/ })).toBeDisabled();
    fireEvent.click(button);
    await waitFor(() =>
      expect(mocks.apiJson).toHaveBeenCalledWith('/story-song/setup', { method: 'POST' }),
    );
  });

  it('says so on a backend that cannot run the feature', async () => {
    routeApi({ setup: () => ({ ...READY, supported: false, ready: false }) });
    renderPage();
    expect(await screen.findByText('easy.story_unsupported')).toBeInTheDocument();
  });

  it('writes lyrics from the story, lets the user edit them, then makes the song', async () => {
    let lyricsBody: unknown = null;
    let songBody: unknown = null;
    routeApi({
      lyrics: (body) => {
        lyricsBody = body;
        return { id: 'bbbbbbbbbbbb', state: 'running', result: null };
      },
      lyricsTask: () => ({
        id: 'bbbbbbbbbbbb',
        state: 'done',
        error: null,
        error_code: null,
        result: { title: 'Sea Night', lyrics: LYRICS },
      }),
      song: (body) => {
        songBody = body;
        return job({ state: 'queued', step: 'preparing', percent: 0, elapsed_s: 0 });
      },
    });
    renderPage();
    expect(screen.getByText('easy.story_notice')).toBeInTheDocument();
    const write = await screen.findByRole('button', { name: /easy.story_write_button/ });
    await waitFor(() => expect(screen.getByText('easy.story_need_story')).toBeInTheDocument());
    expect(write).toBeDisabled();

    fireEvent.change(screen.getByLabelText('easy.story_step_story'), {
      target: { value: STORY },
    });
    const moods = screen.getByRole('radiogroup', { name: 'easy.story_step_mood' });
    fireEvent.click(within(moods).getByRole('radio', { name: 'easy.story_genre_trot' }));
    const lengths = screen.getByRole('radiogroup', { name: 'easy.story_step_length' });
    fireEvent.click(within(lengths).getByRole('radio', { name: 'easy.story_length_2' }));
    const voices = screen.getByRole('radiogroup', { name: 'easy.cover_step_voice' });
    fireEvent.click(within(voices).getByRole('radio', { name: /Mina/ }));
    expect(write).toBeEnabled();
    fireEvent.click(write);
    await waitFor(() => expect(lyricsBody).toEqual({ story: STORY, genre: 'trot', length: '2' }));

    const editor = await screen.findByLabelText('easy.story_step_lyrics');
    expect(editor).toHaveValue(LYRICS);
    expect(screen.getByLabelText('easy.story_song_title')).toHaveValue('Sea Night');
    fireEvent.change(editor, { target: { value: `${LYRICS}\nmy own line` } });
    fireEvent.change(screen.getByLabelText('easy.story_song_title'), {
      target: { value: 'Our Sea' },
    });
    // the draft survives closing the page
    expect(JSON.parse(localStorage.getItem(STORY_DRAFT_KEY) ?? '{}')).toMatchObject({
      phase: 'lyrics',
      title: 'Our Sea',
      genre: 'trot',
      voiceId: 'v2',
    });
    fireEvent.click(screen.getByRole('button', { name: /easy.story_make_button/ }));
    await waitFor(() =>
      expect(songBody).toEqual({
        profile_id: 'v2',
        title: 'Our Sea',
        lyrics: `${LYRICS}\nmy own line`,
        genre: 'trot',
        length: '2',
      }),
    );
  });

  it('can go back to the story and ask for the lyrics again', async () => {
    const posted: unknown[] = [];
    localStorage.setItem(
      STORY_DRAFT_KEY,
      JSON.stringify({ story: STORY, title: 'Sea Night', lyrics: LYRICS, phase: 'lyrics' }),
    );
    routeApi({
      lyrics: (body) => {
        posted.push(body);
        return { id: 'cccccccccccc', state: 'running', result: null };
      },
      lyricsTask: () => ({ id: 'cccccccccccc', state: 'running', result: null }),
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /easy.story_edit_story/ }));
    expect(await screen.findByLabelText('easy.story_step_story')).toHaveValue(STORY);
    fireEvent.click(screen.getByRole('button', { name: /easy.story_back_to_lyrics/ }));
    fireEvent.click(await screen.findByRole('button', { name: /easy.story_rewrite/ }));
    expect(await screen.findByText('easy.story_writing')).toBeInTheDocument();
    expect(posted).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'easy.cancel' }));
    await waitFor(() =>
      expect(mocks.apiJson).toHaveBeenCalledWith('/story-song/lyrics/cccccccccccc/cancel', {
        method: 'POST',
      }),
    );
  });

  it('explains a failed lyrics task in plain words', async () => {
    localStorage.setItem(
      STORY_DRAFT_KEY,
      JSON.stringify({ story: STORY, lyricsTaskId: 'dddddddddddd' }),
    );
    routeApi({
      lyricsTask: () => ({
        id: 'dddddddddddd',
        state: 'error',
        error: 'x',
        error_code: 'out_of_memory',
        result: null,
      }),
    });
    renderPage();
    expect(await screen.findByText('easy.story_lyrics_failed')).toBeInTheDocument();
    expect(screen.getByText('easy.story_err_memory')).toBeInTheDocument();
  });

  it('shows a running song job with its steps, and cancels it', async () => {
    routeApi({ jobs: () => ({ jobs: [job()] }) });
    renderPage();
    const progress = await screen.findByText('easy.cover_making');
    const panel = progress.closest('[data-slot="easy-story-progress"]') as HTMLElement;
    expect(within(panel).getByText('17%')).toBeInTheDocument();
    const steps = panel.querySelectorAll('li');
    expect(Array.from(steps).map((li) => li.getAttribute('data-state'))).toEqual([
      'done',
      'active',
      'waiting',
      'waiting',
      'waiting',
      'waiting',
    ]);
    expect(screen.queryByRole('button', { name: /easy.story_write_button/ })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'easy.cancel' }));
    await waitFor(() =>
      expect(mocks.apiJson).toHaveBeenCalledWith('/story-song/jobs/aaaaaaaaaaaa/cancel', {
        method: 'POST',
      }),
    );
  });

  it('shows both finished takes, the lyrics and a new-song action', async () => {
    const done = job({
      state: 'done',
      step: 'saving',
      percent: 100,
      result: {
        id: 'take0001',
        audio_path: 'take0001.wav',
        audio_url: '/audio/take0001.wav',
        duration_s: 60,
        ai_id: 'take0002',
        ai_audio_path: 'take0002.wav',
        ai_audio_url: '/audio/take0002.wav',
        semitones: -12,
      },
    });
    routeApi({ jobs: () => ({ jobs: [done] }) });
    renderPage();
    const result = await screen.findByLabelText('easy.cover_done');
    expect(within(result).getAllByRole('button', { name: /easy.play/ })).toHaveLength(2);
    expect(within(result).getAllByRole('button', { name: /easy.save_file/ })).toHaveLength(2);
    expect(within(result).getByText('easy.story_take_ai')).toBeInTheDocument();
    expect(result.querySelector('[data-slot="easy-story-result-lyrics"]')?.textContent).toBe(
      LYRICS,
    );
    expect(
      within(result).getByRole('button', { name: /easy.story_save_lyrics/ }),
    ).toBeInTheDocument();
    fireEvent.click(within(result).getByRole('button', { name: /easy.cover_new/ }));
    expect(await screen.findByLabelText('easy.story_step_story')).toBeInTheDocument();
    expect(screen.queryByLabelText('easy.cover_done')).toBeNull();
  });

  it('explains a failed song job in plain words', async () => {
    routeApi({
      jobs: () => ({ jobs: [job({ state: 'error', error_code: 'interrupted', error: 'x' })] }),
    });
    renderPage();
    expect(await screen.findByText('easy.cover_failed')).toBeInTheDocument();
    expect(screen.getByText('easy.story_err_interrupted')).toBeInTheDocument();
  });
});
