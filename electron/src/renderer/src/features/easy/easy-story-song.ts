import { toast } from 'sonner';
import { apiJson, describeError } from '@/lib/api/client';
import { tr } from '@/lib/i18n-text';
import { saveLocalFile } from '@/lib/local-export';
import { easySafeFileName } from './easy-audio';

/**
 * Song from a story (easy screen): the user writes a story, a local language
 * model turns it into lyrics the user can edit, then the backend makes a song
 * from the lyrics and sings it in one of the user's registered voices. Both
 * the lyrics and the song run in the backend on their own; the screen only
 * starts and polls them, and keeps the draft (story, choices, lyrics) on this
 * device so closing the page loses nothing.
 */

export const STORY_GENRES = ['ballad', 'trot', 'kids', 'dance', 'acoustic'] as const;
export type StoryGenre = (typeof STORY_GENRES)[number];

export const STORY_LENGTHS = ['1', '2', '3'] as const;
export type StoryLength = (typeof STORY_LENGTHS)[number];

export const STORY_MAX_CHARS = 2000;
export const STORY_MIN_CHARS = 10;
export const STORY_MAX_LYRICS = 3000;

export type StoryStep =
  | 'preparing'
  | 'composing'
  | 'separating'
  | 'converting'
  | 'mixing'
  | 'saving';
export const STORY_STEPS: readonly StoryStep[] = [
  'preparing',
  'composing',
  'separating',
  'converting',
  'mixing',
  'saving',
];

export type StoryJobState = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface StorySongResult {
  id: string;
  audio_path: string;
  audio_url: string;
  duration_s: number;
  ai_id: string;
  ai_audio_path: string;
  ai_audio_url: string;
  semitones: number | string;
}

export interface StorySongJob {
  id: string;
  state: StoryJobState;
  step: StoryStep;
  step_percent: number;
  percent: number;
  profile_id: string;
  profile_name: string;
  title: string;
  lyrics: string;
  genre: StoryGenre;
  length: StoryLength;
  song_seconds: number | null;
  error: string | null;
  error_code: string | null;
  created_at: number;
  elapsed_s: number;
  result: StorySongResult | null;
}

export interface StoryLyricsTask {
  id: string;
  state: StoryJobState;
  genre: StoryGenre;
  length: StoryLength;
  error: string | null;
  error_code: string | null;
  elapsed_s: number;
  result: { title: string; lyrics: string } | null;
}

export interface StorySongSetup {
  supported: boolean;
  ready: boolean;
  missing_bytes: number;
  total_bytes: number;
  install: {
    state: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
    error: string | null;
    percent: number;
    downloaded_bytes: number;
    total_bytes: number;
  };
}

export const isStoryActive = (job: { state: StoryJobState } | null | undefined): boolean =>
  job?.state === 'queued' || job?.state === 'running';

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const storySongSetup = () => apiJson<StorySongSetup>('/story-song/setup');
export const startStorySongSetup = () =>
  apiJson<StorySongSetup>('/story-song/setup', { method: 'POST' });
export const cancelStorySongSetup = () =>
  apiJson<StorySongSetup>('/story-song/setup/cancel', { method: 'POST' });

export const startStoryLyrics = (input: {
  story: string;
  genre: StoryGenre;
  length: StoryLength;
}) => apiJson<StoryLyricsTask>('/story-song/lyrics', json(input));
export const getStoryLyrics = (id: string) =>
  apiJson<StoryLyricsTask>(`/story-song/lyrics/${encodeURIComponent(id)}`);
export const cancelStoryLyrics = (id: string) =>
  apiJson<StoryLyricsTask>(`/story-song/lyrics/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });

export const listStorySongJobs = () => apiJson<{ jobs: StorySongJob[] }>('/story-song/jobs');
export const cancelStorySongJob = (id: string) =>
  apiJson<StorySongJob>(`/story-song/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
export const startStorySongJob = (input: {
  profileId: string;
  title: string;
  lyrics: string;
  genre: StoryGenre;
  length: StoryLength;
}) =>
  apiJson<StorySongJob>(
    '/story-song/jobs',
    json({
      profile_id: input.profileId,
      title: input.title,
      lyrics: input.lyrics,
      genre: input.genre,
      length: input.length,
    }),
  );

/** The plain-words message key for a failed lyrics task or song job. */
export function storyErrorKey(item: { error_code: string | null }): string | null {
  switch (item.error_code) {
    case 'busy':
      return 'easy.story_err_busy';
    case 'interrupted':
      return 'easy.story_err_interrupted';
    case 'gpu_busy':
      return 'easy.story_err_gpu_busy';
    case 'out_of_memory':
      return 'easy.story_err_memory';
    case 'empty':
      return 'easy.story_err_empty';
    case 'models_missing':
    case 'story_song_models_missing':
      return 'easy.story_err_models';
    default:
      return null;
  }
}

/** Lyrics lines (section tags not counted). */
export function storyLyricLines(lyrics: string): number {
  return lyrics
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('[')).length;
}

export function storySongFileName(job: StorySongJob, ai: boolean): string {
  const title = easySafeFileName(job.title, 'JinVoice-song');
  if (ai) return `${title} - AI.wav`;
  const voice = easySafeFileName(job.profile_name, '');
  return voice ? `${title} - ${voice}.wav` : `${title}.wav`;
}

/** The lyrics of a finished song, saved as a text file. */
export async function saveStoryLyrics(job: StorySongJob): Promise<void> {
  try {
    const text = `${job.title}\n\n${job.lyrics}\n`;
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const name = `${easySafeFileName(job.title, 'JinVoice-song')}.txt`;
    const saved = await saveLocalFile(blob, name);
    if (saved && !saved.canceled) toast.success(tr('easy.saved'));
  } catch (error) {
    toast.error(tr('easy.save_failed', { message: describeError(error) }));
  }
}

/*
 * Draft kept per device: what the user typed and picked, the lyrics they are
 * editing, and the lyrics task still being written (so reopening the page
 * picks the result up). A finished song stays on screen until "new song".
 */
export interface StoryDraft {
  story: string;
  genre: StoryGenre;
  length: StoryLength;
  voiceId: string | null;
  title: string;
  lyrics: string;
  /** 'story' = writing the story; 'lyrics' = editing the lyrics. */
  phase: 'story' | 'lyrics';
  lyricsTaskId: string | null;
  dismissedJobId: string;
}

export const STORY_DRAFT_KEY = 'jinvoice.story-song.draft.v1';

export const emptyStoryDraft = (): StoryDraft => ({
  story: '',
  genre: 'ballad',
  length: '1',
  voiceId: null,
  title: '',
  lyrics: '',
  phase: 'story',
  lyricsTaskId: null,
  dismissedJobId: '',
});

export function loadStoryDraft(): StoryDraft {
  const base = emptyStoryDraft();
  try {
    const raw = globalThis.localStorage?.getItem(STORY_DRAFT_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<StoryDraft>;
    return {
      story: typeof parsed.story === 'string' ? parsed.story.slice(0, STORY_MAX_CHARS) : '',
      genre: STORY_GENRES.includes(parsed.genre as StoryGenre)
        ? (parsed.genre as StoryGenre)
        : base.genre,
      length: STORY_LENGTHS.includes(parsed.length as StoryLength)
        ? (parsed.length as StoryLength)
        : base.length,
      voiceId: typeof parsed.voiceId === 'string' ? parsed.voiceId : null,
      title: typeof parsed.title === 'string' ? parsed.title : '',
      lyrics: typeof parsed.lyrics === 'string' ? parsed.lyrics : '',
      phase: parsed.phase === 'lyrics' ? 'lyrics' : 'story',
      lyricsTaskId: typeof parsed.lyricsTaskId === 'string' ? parsed.lyricsTaskId : null,
      dismissedJobId: typeof parsed.dismissedJobId === 'string' ? parsed.dismissedJobId : '',
    };
  } catch {
    return base;
  }
}

export function saveStoryDraft(draft: StoryDraft): void {
  try {
    globalThis.localStorage?.setItem(STORY_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* Storage can be unavailable; the draft still lives for this session. */
  }
}

/** The job the screen shows: running first, else the newest one not dismissed. */
export function currentStoryJob(
  jobs: readonly StorySongJob[] | undefined,
  dismissedId: string,
): StorySongJob | null {
  if (!jobs?.length) return null;
  const active = jobs.find(isStoryActive);
  if (active) return active;
  const newest = jobs[0];
  return newest && newest.id !== dismissedId ? newest : null;
}
