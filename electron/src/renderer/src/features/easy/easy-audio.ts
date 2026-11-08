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

/** A stretch of a longer file, in seconds (one chapter of a book). */
export interface EasyPlayRange {
  start: number;
  end: number;
}

/** Play `src` (or only `range` of it) under `key`, or stop it when that key is already playing. */
export function toggleEasyPlayback(key: string, src: string, range?: EasyPlayRange): void {
  if (current?.key === key) {
    stopEasyPlayback();
    return;
  }
  stopEasyPlayback();
  const audio = new Audio(src);
  if (range) {
    const seek = () => {
      if (audio.currentTime < range.start) audio.currentTime = range.start;
    };
    if (audio.readyState >= 1) seek();
    else audio.addEventListener('loadedmetadata', seek, { once: true });
    audio.addEventListener('timeupdate', () => {
      if (audio.currentTime >= range.end) {
        audio.pause();
        finish(audio);
      }
    });
  }
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

/** A name that is safe as a file name on every system. */
export function easySafeFileName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  return cleaned || fallback;
}

/** Save a finished file the backend keeps under `/audio/` with its own extension. */
export async function saveEasyAudioFile(audioPath: string, name: string): Promise<void> {
  try {
    const res = await apiFetch(`/audio/${encodeURIComponent(audioPath)}`);
    await save(await res.blob(), name);
  } catch (error) {
    toast.error(tr('easy.save_failed', { message: describeError(error) }));
  }
}

/** 16-bit PCM WAV for mono samples. */
export function encodeEasyWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

const CHAPTER_SAMPLE_RATE = 24_000;

/**
 * Save one chapter of a finished book as its own WAV: the merged file is
 * decoded here and the chapter's stretch (from the renderer's exact
 * per-chapter durations) is cut out, so no second render is needed.
 */
export async function saveEasyAudioSlice(
  audioPath: string,
  range: EasyPlayRange,
  name: string,
): Promise<void> {
  try {
    const res = await apiFetch(`/audio/${encodeURIComponent(audioPath)}`);
    const context = new OfflineAudioContext(1, 1, CHAPTER_SAMPLE_RATE);
    const decoded = await context.decodeAudioData(await res.arrayBuffer());
    const from = Math.max(0, Math.floor(range.start * decoded.sampleRate));
    const to = Math.min(decoded.length, Math.ceil(range.end * decoded.sampleRate));
    const mono = new Float32Array(Math.max(0, to - from));
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const data = decoded.getChannelData(channel).subarray(from, to);
      for (let i = 0; i < mono.length; i += 1)
        mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / decoded.numberOfChannels;
    }
    await save(encodeEasyWav(mono, decoded.sampleRate), name);
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
