import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
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
vi.mock('@/hooks/use-tts-readiness', () => ({ useTtsReadiness: () => null }));
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiJson: mocks.apiJson,
  apiFetch: mocks.apiFetch,
}));
vi.mock('@/lib/local-export', () => ({ saveLocalFile: mocks.saveLocalFile }));
vi.mock('@/components/bridge', () => ({ isMac: () => false, getBridge: () => null }));

import {
  EASY_MODE_STORAGE_KEY,
  easyModeRedirect,
  isEasyModeEnabled,
  reloadEasyModePreference,
  setEasyModeEnabled,
} from '@/lib/easy-mode';
import { useEasyModeSwitch } from '@/lib/use-easy-mode-switch';
import { rootRoute } from '@/routes/index';
import { EasyAudiobookPage } from './easy-audiobook-page';
import {
  decodeEasyText,
  easyBookChapters,
  easyBookPreview,
  easyBookScript,
  easyChapterRanges,
  resetEasyBookForTests,
} from './easy-audiobook';
import { EasyHelpPage } from './easy-help-page';

const labels = { part: (n: number) => `P${n}`, intro: 'Intro' };

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

function renderWithQuery(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** An SSE response the test pushes events into. */
function controlledStream() {
  let push!: (event: object) => void;
  let close!: () => void;
  let fail!: (error: unknown) => void;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      close = () => controller.close();
      fail = (error) => controller.error(error);
    },
  });
  return {
    response: new Response(body),
    push: (e: object) => push(e),
    close: () => close(),
    /** Like a real fetch: aborting the request errors the body stream. */
    abortOn: (signal?: AbortSignal | null) =>
      signal?.addEventListener('abort', () => fail(new DOMException('Aborted', 'AbortError'))),
  };
}

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
  resetEasyBookForTests();
  mocks.profiles = { data: [], isLoading: false };
  mocks.apiJson.mockResolvedValue({ jobs: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setEasyModeEnabled(true);
});

describe('easy mode preference', () => {
  it('defaults to easy and persists the switch both ways', () => {
    expect(isEasyModeEnabled()).toBe(true);
    setEasyModeEnabled(false);
    expect(localStorage.getItem(EASY_MODE_STORAGE_KEY)).toBe('0');
    reloadEasyModePreference();
    expect(isEasyModeEnabled()).toBe(false);
    setEasyModeEnabled(true);
    expect(localStorage.getItem(EASY_MODE_STORAGE_KEY)).toBe('1');
    reloadEasyModePreference();
    expect(isEasyModeEnabled()).toBe(true);
  });

  it('flips the root route guard live, without a restart', () => {
    expect(guard('/dub')).toBe('/');
    expect(guard('/pro')).toBe('/');
    expect(guard('/settings/support')).toBe('/');
    expect(guard('/easy/audiobook')).toBeNull();
    setEasyModeEnabled(false);
    // Full UI: every upstream route opens, including upstream's own Pro/support pages.
    expect(guard('/dub')).toBeNull();
    expect(guard('/audiobook')).toBeNull();
    expect(guard('/pro')).toBeNull();
    expect(guard('/settings/support')).toBeNull();
    setEasyModeEnabled(true);
    expect(guard('/dub')).toBe('/');
    expect(easyModeRedirect('/clone', false)).toBeNull();
  });

  it('the Settings switch saves the choice and goes home', () => {
    const { result } = renderHook(() => useEasyModeSwitch());
    act(() => result.current(false));
    expect(isEasyModeEnabled()).toBe(false);
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: '/' });
    act(() => result.current(true));
    expect(isEasyModeEnabled()).toBe(true);
    expect(localStorage.getItem(EASY_MODE_STORAGE_KEY)).toBe('1');
  });
});

describe('easy audiobook text', () => {
  it('keeps the user’s own # headings and titles text before them', () => {
    const script = easyBookScript('Before\n# One\nA.\n# Two\nB.', labels);
    expect(easyBookPreview(script).map((chapter) => chapter.title)).toEqual([
      'Intro',
      'One',
      'Two',
    ]);
  });

  it('turns chapter lines (Korean and English) into chapters', () => {
    const korean = '\uC81C1\uC7A5\nAaa.\n\n\uC81C 2 \uC7A5\nBbb.';
    expect(easyBookPreview(easyBookScript(korean, labels)).map((c) => c.title)).toEqual([
      '\uC81C1\uC7A5',
      '\uC81C 2 \uC7A5',
    ]);
    const english = 'Chapter 1\nHello.\n\nChapter 2\nWorld.';
    expect(easyBookPreview(easyBookScript(english, labels))).toEqual([
      { title: 'Chapter 1', chars: 6 },
      { title: 'Chapter 2', chars: 6 },
    ]);
  });

  it('cuts plain prose at paragraph breaks into parts', () => {
    const paragraph = 'x'.repeat(40);
    const text = Array.from({ length: 5 }, () => paragraph).join('\n\n');
    const preview = easyBookPreview(easyBookScript(text, labels, 100));
    expect(preview.map((chapter) => chapter.title)).toEqual(['P1', 'P2', 'P3']);
    expect(preview.reduce((sum, chapter) => sum + chapter.chars, 0)).toBeGreaterThanOrEqual(200);
  });

  it('puts the voice and speed on every span, leaving normal speed unset', () => {
    const script = easyBookScript('Chapter 1\nHello.', labels);
    const fast = easyBookChapters(script, 'v1', 1.2);
    expect(fast[0]?.spans[0]).toMatchObject({ voice_id: 'v1', speed: 1.2 });
    expect(easyBookChapters(script, 'v1', 1)[0]?.spans[0]?.speed).toBeNull();
  });

  it('reads UTF-8 and Korean CP949 text files', () => {
    expect(decodeEasyText(new TextEncoder().encode('caf\u00e9'))).toBe('caf\u00e9');
    // "\uAC00\uAC01" in EUC-KR / CP949.
    expect(decodeEasyText(new Uint8Array([0xb0, 0xa1, 0xb0, 0xa2]))).toBe('\uAC00\uAC01');
  });

  it('places finished chapters back to back in the merged file, skipping failed ones', () => {
    expect(
      easyChapterRanges([
        { title: 'a', status: 'done', durationMs: 1000 },
        { title: 'b', status: 'failed' },
        { title: 'c', status: 'done', durationMs: 500 },
      ]),
    ).toEqual([{ start: 0, end: 1000 }, null, { start: 1000, end: 1500 }]);
  });
});

describe('EasyAudiobookPage', () => {
  const startButton = () => screen.getByRole('button', { name: /easy\.book_start/ });

  it('loads a text file, previews chapters, renders with progress, and exports the book', async () => {
    mocks.profiles = { data: [voice('v1', 'Mine')], isLoading: false };
    const stream = controlledStream();
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/longform/render') return stream.response;
      return new Response(new Blob(['ID3']));
    });
    renderWithQuery(<EasyAudiobookPage />);
    expect(startButton()).toBeDisabled();
    expect(screen.getByText('easy.book_need_text')).toBeInTheDocument();

    const file = new File(
      [new TextEncoder().encode('Chapter 1\nHello.\n\nChapter 2\nWorld.')],
      'My book.txt',
      {
        type: 'text/plain',
      },
    );
    fireEvent.change(screen.getByTestId('easy-book-file'), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'easy.book_step_text' })).toHaveValue(
        'Chapter 1\nHello.\n\nChapter 2\nWorld.',
      ),
    );
    expect(screen.getByRole('textbox', { name: 'easy.book_title_label' })).toHaveValue('My book');
    const preview = document.querySelector('[data-slot="easy-book-preview"]') as HTMLElement;
    await waitFor(() => expect(within(preview).getAllByRole('listitem')).toHaveLength(2));
    expect(preview).toHaveTextContent('Chapter 1');
    expect(preview).toHaveTextContent('Chapter 2');

    fireEvent.click(screen.getByRole('radio', { name: /easy\.speed_fast/ }));
    expect(startButton()).toBeEnabled();
    fireEvent.click(startButton());
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalled());
    const [path, init] = mocks.apiFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/longform/render');
    const body = JSON.parse(String(init.body));
    expect(body.default_voice).toBe('v1');
    expect(body.format).toBe('mp3');
    expect(body.metadata).toEqual({ title: 'My book' });
    expect(body.chapters).toHaveLength(2);
    expect(body.chapters[0]).toMatchObject({
      title: 'Chapter 1',
      spans: [expect.objectContaining({ voice_id: 'v1', speed: 1.2, text: 'Hello.' })],
    });

    // Progress: waiting → making → done / failed.
    await act(async () => stream.push({ type: 'started', chapters: 2 }));
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-slot="easy-book-progress"] [data-status]'),
      ).toHaveLength(2),
    );
    const statuses = () =>
      Array.from(document.querySelectorAll('[data-slot="easy-book-progress"] [data-status]')).map(
        (node) => node.getAttribute('data-status'),
      );
    expect(statuses()).toEqual(['rendering', 'pending']);
    await act(async () =>
      stream.push({ type: 'chapter', index: 0, total: 2, title: 'Chapter 1', duration_ms: 1500 }),
    );
    await waitFor(() => expect(statuses()).toEqual(['done', 'rendering']));
    await act(async () =>
      stream.push({
        type: 'chapter_error',
        index: 1,
        total: 2,
        title: 'Chapter 2',
        reason: 'boom',
      }),
    );
    await waitFor(() => expect(statuses()).toEqual(['done', 'failed']));
    await act(async () => {
      stream.push({ type: 'assembling' });
      stream.push({ type: 'done', output: 'audiobooks/my-book.mp3', failed_chapters: [1] });
      stream.close();
    });

    const result = await screen.findByLabelText('easy.book_done_title');
    expect(within(result).getByText('easy.book_failed_chapters')).toBeInTheDocument();
    expect(within(result).getByRole('button', { name: /easy\.book_retry/ })).toBeInTheDocument();
    expect(within(result).getAllByRole('button', { name: 'easy.book_save_chapter' })).toHaveLength(
      1,
    );

    // Merged export: the finished file from /audio, saved under the book title.
    fireEvent.click(within(result).getByRole('button', { name: /easy\.book_save_all/ }));
    await waitFor(() => expect(mocks.saveLocalFile).toHaveBeenCalled());
    expect(mocks.apiFetch).toHaveBeenCalledWith('/audio/audiobooks%2Fmy-book.mp3');
    expect(mocks.saveLocalFile.mock.calls[0]?.[1]).toBe('My book.mp3');
  });

  it('can stop a running book', async () => {
    mocks.profiles = { data: [voice('v1', 'Mine')], isLoading: false };
    const stream = controlledStream();
    mocks.apiFetch.mockImplementation(async (_path: string, init: RequestInit) => {
      stream.abortOn(init.signal);
      return stream.response;
    });
    renderWithQuery(<EasyAudiobookPage />);
    fireEvent.change(screen.getByRole('textbox', { name: 'easy.book_step_text' }), {
      target: { value: 'Hello there.' },
    });
    await waitFor(() => expect(startButton()).toBeEnabled());
    fireEvent.click(startButton());
    await act(async () => stream.push({ type: 'started', chapters: 1 }));
    fireEvent.click(await screen.findByRole('button', { name: /easy\.book_stop/ }));
    expect(await screen.findByText('easy.book_stopped_title')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /easy\.book_retry/ })).toBeInTheDocument();
  });

  it('deletes an unfinished book after confirming', async () => {
    mocks.profiles = { data: [voice('v1', 'Mine')], isLoading: false };
    let jobs = [{ job_id: 'job 1', type: 'audiobook', title: 'Old book', chapters_done: 1, total_chapters: 3 }];
    mocks.apiJson.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') {
        jobs = [];
        return { deleted: 'job 1' };
      }
      return { jobs };
    });
    renderWithQuery(<EasyAudiobookPage />);
    const row = await screen.findByText('easy.book_resume_title');
    expect(row).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'easy.delete' }));
    expect(screen.getByText('easy.book_delete_title')).toBeInTheDocument();
    expect(mocks.apiJson).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'DELETE' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'easy.delete' }));
    await waitFor(() =>
      expect(mocks.apiJson).toHaveBeenCalledWith('/audiobook/jobs/job%201', { method: 'DELETE' }),
    );
    await waitFor(() => expect(screen.queryByText('easy.book_resume_title')).not.toBeInTheDocument());
  });

  it('resumes an interrupted book through upstream’s resume endpoint', async () => {
    mocks.profiles = { data: [voice('v1', 'Mine')], isLoading: false };
    mocks.apiJson.mockResolvedValue({
      jobs: [
        { job_id: 'job 1', type: 'story', title: 'Old book', chapters_done: 1, total_chapters: 3 },
      ],
    });
    const stream = controlledStream();
    mocks.apiFetch.mockResolvedValue(stream.response);
    renderWithQuery(<EasyAudiobookPage />);
    expect(mocks.apiJson).toHaveBeenCalledWith('/audiobook/jobs', expect.anything());
    fireEvent.click(await screen.findByRole('button', { name: 'easy.book_resume' }));
    await waitFor(() =>
      expect(mocks.apiFetch).toHaveBeenCalledWith(
        '/audiobook/resume/job%201',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    await act(async () => {
      stream.push({ type: 'started', chapters: 3 });
      stream.push({
        type: 'chapter',
        index: 0,
        total: 3,
        title: 'One',
        duration_ms: 100,
        cached: true,
      });
    });
    expect(await screen.findByText('One')).toBeInTheDocument();
    await act(async () => {
      stream.push({ type: 'chapter', index: 1, total: 3, title: 'Two', duration_ms: 100 });
      stream.push({ type: 'chapter', index: 2, total: 3, title: 'Three', duration_ms: 100 });
      stream.push({ type: 'done', output: 'b.mp3', failed_chapters: [] });
      stream.close();
    });
    expect(await screen.findByLabelText('easy.book_done_title')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'easy.book_save_chapter' })).toHaveLength(3);
  });
});

describe('EasyHelpPage', () => {
  it('explains every easy screen and how to bring back hidden features', () => {
    render(<EasyHelpPage />);
    for (const key of [
      'easy.help_create_title',
      'easy.help_voice_title',
      'easy.help_book_title',
      'easy.help_history_title',
      'easy.help_more_title',
      'easy.help_voice_formats',
      'easy.help_voice_tip',
    ])
      expect(screen.getByText(key)).toBeInTheDocument();
    expect(document.querySelectorAll('[data-slot="easy-help-section"]')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: /easy\.help_open_settings/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: '/settings/general' });
  });
});
