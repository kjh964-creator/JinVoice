import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '@/lib/api/types';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  profiles: { data: [] as unknown[], isLoading: false },
  history: { data: [] as unknown[], isLoading: false },
  generate: vi.fn(),
  generation: {
    isGenerating: false,
    canGenerate: true,
    cloneBlocker: null as string | null,
    error: null as string | null,
  },
  apiJson: vi.fn(),
  createCloneProfile: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  Outlet: () => null,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/hooks/use-profiles', () => ({ useProfiles: () => mocks.profiles }));
vi.mock('@/hooks/use-history', () => ({ useHistory: () => mocks.history }));
vi.mock('@/hooks/use-engines', () => ({ useEngines: () => ({ activeTts: null }) }));
vi.mock('@/hooks/use-generate', () => ({
  useGenerateClone: () => ({
    ...mocks.generation,
    generate: mocks.generate,
    cancel: vi.fn(),
    elapsedSeconds: 0,
    progress: null,
    stage: 'generating',
  }),
}));
vi.mock('@/hooks/use-recording', () => ({
  useRecording: () => ({
    isRecording: false,
    isStarting: false,
    isCleaning: false,
    seconds: 0,
    level: 0,
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));
vi.mock('@/lib/audio/probe', () => ({ probeAudioDuration: async () => 6 }));
vi.mock('@/lib/audio/object-url', () => ({
  createObjectUrl: () => 'blob:preview',
  revokeObjectUrl: () => {},
}));
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiJson: mocks.apiJson,
}));
vi.mock('@/lib/api/profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/profiles')>()),
  createCloneProfile: mocks.createCloneProfile,
}));
vi.mock('@/components/bridge', () => ({ isMac: () => false, getBridge: () => null }));

import { isEasyModePath } from '@/lib/easy-mode';
import { setCloneSetting } from '@/lib/store/clone-settings';
import { EasyHomePage } from './easy-home-page';
import { EasyCreatePage } from './easy-create-page';
import { EasyVoicesPage } from './easy-voices-page';
import { EasyHistoryPage } from './easy-history-page';
import { EasyRegisterWizard } from './easy-register-wizard';

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

beforeEach(() => {
  mocks.profiles = { data: [], isLoading: false };
  mocks.history = { data: [], isLoading: false };
  mocks.generation = { isGenerating: false, canGenerate: true, cloneBlocker: null, error: null };
  setCloneSetting('text', '');
  setCloneSetting('selectedProfileId', null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('easy mode routes', () => {
  it('allows only the easy screens and Settings', () => {
    expect(isEasyModePath('/')).toBe(true);
    expect(isEasyModePath('/easy/create')).toBe(true);
    expect(isEasyModePath('/easy/voices/new')).toBe(true);
    expect(isEasyModePath('/settings/models')).toBe(true);
    expect(isEasyModePath('/clone')).toBe(false);
    expect(isEasyModePath('/dub')).toBe(false);
    expect(isEasyModePath('/pro')).toBe(false);
    // No donation / support-plan / cloud account (Pro) pages.
    expect(isEasyModePath('/settings/support')).toBe(false);
    expect(isEasyModePath('/settings/account')).toBe(false);
    expect(isEasyModePath('/integrations')).toBe(false);
  });
});

describe('EasyHomePage', () => {
  it('shows four big cards in a 2x2 grid that open each easy screen', () => {
    render(<EasyHomePage />);
    // Four big cards; the quiet "turn on more features" link is not one of them.
    expect(document.querySelectorAll('[data-slot="easy-home-card"]')).toHaveLength(4);
    expect(screen.getAllByRole('button')).toHaveLength(5);
    expect(document.querySelector('[data-slot="easy-home-grid"]')).toHaveClass('sm:grid-cols-2');
    fireEvent.click(screen.getByRole('button', { name: /easy\.audiobook_title/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: '/easy/audiobook' });
    fireEvent.click(screen.getByRole('button', { name: /easy\.create_title/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: '/easy/create' });
    fireEvent.click(screen.getByRole('button', { name: /easy\.voices_title/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: '/easy/voices' });
    fireEvent.click(screen.getByRole('button', { name: /easy\.history_title/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: '/easy/history' });
  });
});

describe('EasyCreatePage', () => {
  const createButton = () => screen.getByRole('button', { name: 'easy.create_button' });

  it('keeps the create button off without a voice', () => {
    setCloneSetting('text', 'Hello there');
    render(<EasyCreatePage />);
    expect(screen.getByText('easy.no_voices_title')).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
    expect(screen.getByText('easy.need_voice')).toBeInTheDocument();
  });

  it('keeps the create button off without text, then makes speech with voice + text', () => {
    mocks.profiles = { data: [voice('v1', 'Mine')], isLoading: false };
    render(<EasyCreatePage />);
    expect(screen.getByRole('radio', { name: /Mine/ })).toHaveAttribute('aria-checked', 'true');
    expect(createButton()).toBeDisabled();
    expect(screen.getByText('easy.need_text')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'easy.step_text' }), {
      target: { value: 'Hello there' },
    });
    expect(createButton()).toBeEnabled();
    fireEvent.click(createButton());
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it('offers Settings instead of a dead button when downloads are missing', () => {
    mocks.profiles = { data: [voice('v1', 'Mine')], isLoading: false };
    mocks.generation = { ...mocks.generation, canGenerate: false, cloneBlocker: 'engine' };
    setCloneSetting('text', 'Hello');
    render(<EasyCreatePage />);
    expect(screen.getByText('easy.setup_needed_title')).toBeInTheDocument();
    expect(createButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'easy.open_settings' }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/settings/models' });
  });

  it('accepts up to 5000 characters and points long text to the audiobook page', () => {
    mocks.profiles = { data: [voice('v1', 'Mine')], isLoading: false };
    setCloneSetting('text', 'a'.repeat(4500));
    render(<EasyCreatePage />);
    expect(createButton()).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /easy\.long_text_hint/ }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/easy/audiobook' });
    cleanup();
    setCloneSetting('text', 'a'.repeat(5001));
    render(<EasyCreatePage />);
    expect(createButton()).toBeDisabled();
    expect(screen.getByText('easy.too_long')).toBeInTheDocument();
  });

  it('shows a waiting state while speech is being made', () => {
    mocks.profiles = { data: [voice('v1', 'Mine')], isLoading: false };
    mocks.generation = { ...mocks.generation, isGenerating: true, canGenerate: false };
    render(<EasyCreatePage />);
    expect(screen.getByText('easy.making')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'easy.create_button' })).not.toBeInTheDocument();
  });
});

describe('EasyVoicesPage', () => {
  it('shows a friendly empty state with a register button', () => {
    renderWithQuery(<EasyVoicesPage />);
    expect(screen.getByText('easy.no_voices_title')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'easy.register_voice' }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/easy/voices/new' });
  });

  it('lists voices with play, rename and delete (confirmed)', () => {
    mocks.profiles = { data: [voice('v1', 'Mine'), voice('v2', 'Mum')], isLoading: false };
    renderWithQuery(<EasyVoicesPage />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const row = within(rows[0]);
    expect(row.getByRole('button', { name: 'easy.play' })).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'easy.rename' })).toBeInTheDocument();
    fireEvent.click(row.getByRole('button', { name: 'easy.delete' }));
    expect(screen.getByText('easy.delete_voice_body')).toBeInTheDocument();
  });

  it('saves a voice recording under the voice name', async () => {
    mocks.profiles = { data: [voice('v1', 'Mine')], isLoading: false };
    const fetchMock = vi.fn(async (_url: unknown) =>
      new Response(new Blob(['RIFF']), { status: 200, headers: { 'content-type': 'audio/wav' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const saveLocalFile = vi.spyOn(await import('@/lib/local-export'), 'saveLocalFile').mockResolvedValue(
      { canceled: false } as never,
    );
    renderWithQuery(<EasyVoicesPage />);
    fireEvent.click(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: 'easy.save_short' }));
    await waitFor(() => expect(saveLocalFile).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toContain('/profiles/v1/audio');
    expect(saveLocalFile.mock.calls[0][1]).toBe('Mine.wav');
    vi.unstubAllGlobals();
    saveLocalFile.mockRestore();
  });
});

describe('easyVoiceExt', () => {
  it('picks the extension from the type, then the URL, else wav', async () => {
    const { easyVoiceExt } = await import('./easy-audio');
    expect(easyVoiceExt('audio/mpeg', '/x')).toBe('mp3');
    expect(easyVoiceExt('audio/x-wav; charset=binary', '/x')).toBe('wav');
    expect(easyVoiceExt('application/octet-stream', '/voice_audio/a.flac?t=1')).toBe('flac');
    expect(easyVoiceExt(null, '/voice_audio/a.exe')).toBe('wav');
  });
});

describe('EasyHistoryPage', () => {
  it('lists made speech newest first', () => {
    mocks.profiles = { data: [voice('v1', 'Mine')], isLoading: false };
    mocks.history = {
      isLoading: false,
      data: [
        { id: 'old', text: 'Older line', profile_id: 'v1', audio_path: 'a.wav', created_at: 100 },
        { id: 'new', text: 'Newer line', profile_id: 'v1', audio_path: 'b.wav', created_at: 200 },
      ],
    };
    renderWithQuery(<EasyHistoryPage />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Newer line');
    expect(rows[1]).toHaveTextContent('Older line');
    expect(rows[0]).toHaveTextContent('Mine');
  });

  it('shows an empty state', () => {
    renderWithQuery(<EasyHistoryPage />);
    expect(screen.getByText('easy.no_history_title')).toBeInTheDocument();
  });
});

describe('EasyRegisterWizard', () => {
  it('requires a confirmed transcript and consent before saving', async () => {
    mocks.apiJson.mockResolvedValue({ text: 'hello there' });
    mocks.createCloneProfile.mockResolvedValue(voice('new', 'Mine'));
    renderWithQuery(<EasyRegisterWizard />);
    const next = () => screen.getByRole('button', { name: /easy\.next/ });

    // ① name
    expect(next()).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'easy.voice_name' }), {
      target: { value: 'Mine' },
    });
    fireEvent.click(next());

    // ② audio from a file
    expect(screen.getByText('easy.example_sentence')).toBeInTheDocument();
    expect(next()).toBeDisabled();
    fireEvent.click(screen.getByRole('tab', { name: /easy\.source_file/ }));
    fireEvent.change(screen.getByTestId('easy-audio-file'), {
      target: { files: [new File(['RIFF'], 'me.wav', { type: 'audio/wav' })] },
    });
    await screen.findByText('easy.audio_ready');
    fireEvent.click(next());

    // ③ the recognised words are shown, editable, and must be confirmed
    const transcript = await screen.findByDisplayValue('hello there');
    expect(mocks.apiJson).toHaveBeenCalledWith('/transcribe', expect.anything());
    expect(next()).toBeDisabled();
    fireEvent.change(transcript, { target: { value: 'hello there friend' } });
    expect(next()).toBeDisabled();
    fireEvent.click(screen.getByTestId('easy-transcript-confirm'));
    expect(next()).toBeEnabled();
    fireEvent.click(next());

    // ④ consent before saving
    const saveButton = screen.getByRole('button', { name: /easy\.save_voice/ });
    expect(saveButton).toBeDisabled();
    fireEvent.click(screen.getByTestId('easy-consent'));
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);
    await waitFor(() => expect(mocks.createCloneProfile).toHaveBeenCalledTimes(1));
    expect(mocks.createCloneProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Mine',
        refText: 'hello there friend',
        refAudioName: 'me.wav',
      }),
    );
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: '/easy/voices' }));
  });

  it('lets the user type the words when they could not be recognised', async () => {
    mocks.apiJson.mockRejectedValue(new Error('offline'));
    renderWithQuery(<EasyRegisterWizard />);
    fireEvent.change(screen.getByRole('textbox', { name: 'easy.voice_name' }), {
      target: { value: 'Mine' },
    });
    fireEvent.click(screen.getByRole('button', { name: /easy\.next/ }));
    fireEvent.click(screen.getByRole('tab', { name: /easy\.source_file/ }));
    fireEvent.change(screen.getByTestId('easy-audio-file'), {
      target: { files: [new File(['RIFF'], 'me.wav', { type: 'audio/wav' })] },
    });
    await screen.findByText('easy.audio_ready');
    fireEvent.click(screen.getByRole('button', { name: /easy\.next/ }));
    await screen.findByText('easy.text_failed');
    fireEvent.click(screen.getByTestId('easy-transcript-confirm'));
    // Confirming an empty transcript is not enough.
    expect(screen.getByRole('button', { name: /easy\.next/ })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'easy.text_question' }), {
      target: { value: 'typed by hand' },
    });
    expect(screen.getByRole('button', { name: /easy\.next/ })).toBeEnabled();
  });
});

describe('EasyWebSession', () => {
  it('finds the gate root only for the /jinvoice/app web build', async () => {
    const { jinvoiceWebRoot } = await import('./easy-web-session');
    expect(jinvoiceWebRoot('/jinvoice/app')).toBe('/jinvoice');
    expect(jinvoiceWebRoot('')).toBeNull();
    expect(jinvoiceWebRoot('/other/app')).toBeNull();
  });

  it('shows the signed-in name and a log-out link from /jinvoice/me', async () => {
    const { EasyWebSession } = await import('./easy-web-session');
    const fetchMock = vi.fn(async (_url: unknown) =>
      new Response(JSON.stringify({ logged_in: true, name: '민수' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<EasyWebSession root="/jinvoice" />);
    const link = await screen.findByRole('link', { name: 'easy.logout' });
    expect(link).toHaveAttribute('href', '/jinvoice/logout');
    expect(String(fetchMock.mock.calls[0][0])).toBe('/jinvoice/me');
    vi.unstubAllGlobals();
  });

  it('shows nothing in the desktop app or when signed out', async () => {
    const { EasyWebSession } = await import('./easy-web-session');
    const fetchMock = vi.fn(async (_url: unknown) => new Response(JSON.stringify({ logged_in: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<EasyWebSession root={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
    cleanup();
    const out = render(<EasyWebSession root="/jinvoice" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(out.container).toBeEmptyDOMElement();
    vi.unstubAllGlobals();
  });
});
