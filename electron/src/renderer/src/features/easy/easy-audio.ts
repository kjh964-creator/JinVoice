import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { apiFetch, describeError } from '@/lib/api/client';
import { claimPlayback } from '@/lib/audio/playback';
import { saveLocalFile } from '@/lib/local-export';
import { tr } from '@/lib/i18n-text';

/**
 * One playback at a time for every easy screen: pressing play on any row
 * stops whatever else was playing, and each row's button follows that state.
 * Every start gets a fresh element so a late `pause` event from the previous
 * clip can never clear the new one.
 */
let current: { key: string; audio: HTMLAudioElement; release: () => void } | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function finish(audio: HTMLAudioElement) {
  if (current?.audio !== audio) return;
  const { release } = current;
  current = null;
  release();
  notify();
}

export function stopEasyPlayback(): void {
  const playing = current;
  if (!playing) return;
  playing.audio.pause();
  finish(playing.audio);
}

/** Play `src` under `key`, or stop it when that key is already playing. */
export function toggleEasyPlayback(key: string, src: string): void {
  if (current?.key === key) {
    stopEasyPlayback();
    return;
  }
  stopEasyPlayback();
  const audio = new Audio(src);
  const release = claimPlayback(() => {
    audio.pause();
    finish(audio);
  }, 'easy-mode');
  current = { key, audio, release };
  audio.addEventListener('ended', () => finish(audio));
  audio.addEventListener('error', () => {
    if (current?.audio === audio) toast.error(tr('easy.play_failed'));
    finish(audio);
  });
  notify();
  void audio.play().catch(() => finish(audio));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useEasyPlaying(key: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => current?.key === key,
    () => false,
  );
}

function stamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function easyFileName(date?: Date | null): string {
  return `JinVoice-${stamp(date ?? new Date())}.wav`;
}

async function save(blob: Blob, name: string): Promise<void> {
  const saved = await saveLocalFile(blob, name);
  if (saved && !saved.canceled) toast.success(tr('easy.saved'));
}

/** Save an in-memory WAV (the take that was just made). */
export async function saveEasyBlob(blob: Blob, date?: Date | null): Promise<void> {
  try {
    await save(blob, easyFileName(date));
  } catch (error) {
    toast.error(tr('easy.save_failed', { message: describeError(error) }));
  }
}

/** Save a WAV the backend keeps under `/audio/` (an earlier take). */
export async function saveEasyAudioPath(audioPath: string, date?: Date | null): Promise<void> {
  try {
    const res = await apiFetch(`/audio/${encodeURIComponent(audioPath)}`);
    await save(await res.blob(), easyFileName(date));
  } catch (error) {
    toast.error(tr('easy.save_failed', { message: describeError(error) }));
  }
}

/** Epoch seconds or ISO string from the backend → Date. */
export function easyDate(value: number | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
