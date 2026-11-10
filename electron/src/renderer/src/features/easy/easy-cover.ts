import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { apiFetch, apiJson, describeError } from '@/lib/api/client';
import { tr } from '@/lib/i18n-text';
import { saveLocalFile } from '@/lib/local-export';
import { easySafeFileName } from './easy-audio';

/**
 * Song cover (easy screen): the backend sings an uploaded song in one of the
 * user's registered voices. The job runs in the backend on its own, so the
 * screen only starts it and polls; leaving the page (or a phone screen turning
 * off) does not stop it, and reopening the page shows the newest job again.
 */

export type CoverStep = 'preparing' | 'separating' | 'converting' | 'mixing' | 'saving';
export const COVER_STEPS: readonly CoverStep[] = [
  'preparing',
  'separating',
  'converting',
  'mixing',
  'saving',
];

export type CoverState = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface CoverResult {
  id: string;
  audio_path: string;
  audio_url: string;
  duration_s: number;
  semitones: number | string;
  has_instrumental?: boolean;
}

export interface CoverJob {
  id: string;
  state: CoverState;
  step: CoverStep;
  step_percent: number;
  percent: number;
  profile_id: string;
  profile_name: string;
  song_name: string;
  semitones: number | 'auto';
  song_seconds: number | null;
  error: string | null;
  error_code: string | null;
  created_at: number;
  elapsed_s: number;
  result: CoverResult | null;
}

export interface CoverSetup {
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

export const COVER_PITCH_RANGE = 12;
/** Largest upload the screen sends (the backend accepts up to 200 MB). */
export const COVER_MAX_BYTES = 200 * 1024 * 1024;
export const COVER_ACCEPT = 'audio/*,.mp3,.wav,.m4a,.flac,.ogg,.aac';

export const isCoverActive = (job: CoverJob | null | undefined): boolean =>
  job?.state === 'queued' || job?.state === 'running';

export const coverSetup = () => apiJson<CoverSetup>('/cover/setup');
export const startCoverSetup = () => apiJson<CoverSetup>('/cover/setup', { method: 'POST' });
export const cancelCoverSetup = () =>
  apiJson<CoverSetup>('/cover/setup/cancel', { method: 'POST' });
export const listCoverJobs = () => apiJson<{ jobs: CoverJob[] }>('/cover/jobs');
export const cancelCoverJob = (id: string) =>
  apiJson<CoverJob>(`/cover/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });

export function startCoverJob(input: {
  file: File;
  profileId: string;
  semitones: number | 'auto';
}): Promise<CoverJob> {
  const body = new FormData();
  body.append('audio', input.file, input.file.name);
  body.append('profile_id', input.profileId);
  body.append('semitones', String(input.semitones));
  return apiJson<CoverJob>('/cover/jobs', { method: 'POST', body });
}

/** The separated instrumental of a finished job, saved as a WAV file. */
export async function saveCoverInstrumental(job: CoverJob): Promise<void> {
  try {
    const res = await apiFetch(`/cover/jobs/${encodeURIComponent(job.id)}/instrumental`);
    const name = `${easySafeFileName(job.song_name, 'JinVoice-song')}-instrumental.wav`;
    const saved = await saveLocalFile(await res.blob(), name);
    if (saved && !saved.canceled) toast.success(tr('easy.saved'));
  } catch (error) {
    toast.error(tr('easy.save_failed', { message: describeError(error) }));
  }
}

export function coverFileName(job: CoverJob): string {
  const song = easySafeFileName(job.song_name, 'JinVoice-song');
  const voice = easySafeFileName(job.profile_name, '');
  return voice ? `${song} - ${voice}.wav` : `${song}.wav`;
}

/** The plain-words message key for a failed job (the backend's short error code). */
export function coverErrorKey(job: Pick<CoverJob, 'error_code'>): string | null {
  switch (job.error_code) {
    case 'busy':
      return 'easy.cover_err_busy';
    case 'interrupted':
      return 'easy.cover_err_interrupted';
    case 'too_long':
      return 'easy.cover_err_too_long';
    case 'too_short':
    case 'unreadable':
      return 'easy.cover_err_unreadable';
    case 'gpu_busy':
      return 'easy.cover_err_gpu_busy';
    case 'out_of_memory':
      return 'easy.cover_err_memory';
    default:
      return null;
  }
}

/** "1:05" style clock for elapsed time and song length. */
export function coverClock(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.round(seconds ?? 0));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

export function coverPitchLabel(value: number | string): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '0';
  return n > 0 ? `+${n}` : `${n}`;
}

export function coverMegabytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/*
 * A finished job stays on screen until the user starts a new song; "new
 * song" only hides it here (the take itself stays in the made-speech list).
 * Saved per device so the phone and the PC each keep their own view.
 */
const DISMISSED_KEY = 'jinvoice.cover.dismissed.v1';

function readDismissed(): string {
  try {
    return globalThis.localStorage?.getItem(DISMISSED_KEY) ?? '';
  } catch {
    return '';
  }
}

let dismissed = readDismissed();
const listeners = new Set<() => void>();

export function dismissCoverJob(id: string): void {
  dismissed = id;
  try {
    globalThis.localStorage?.setItem(DISMISSED_KEY, id);
  } catch {
    /* Storage can be unavailable; the choice still applies to this session. */
  }
  for (const listener of listeners) listener();
}

export function useDismissedCoverJob(): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => dismissed,
    () => dismissed,
  );
}

/** The job the screen shows: running first, else the newest one not dismissed. */
export function currentCoverJob(
  jobs: readonly CoverJob[] | undefined,
  dismissedId: string,
): CoverJob | null {
  if (!jobs?.length) return null;
  const active = jobs.find(isCoverActive);
  if (active) return active;
  const newest = jobs[0];
  return newest && newest.id !== dismissedId ? newest : null;
}
