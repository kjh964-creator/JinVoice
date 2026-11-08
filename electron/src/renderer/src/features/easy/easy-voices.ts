import type { Profile } from '@/lib/api/types';
import { easyDate } from './easy-audio';

/** The voices easy mode lists and can speak with: saved recordings, newest first. */
export function easyVoices(profiles: Profile[] | undefined): Profile[] {
  return (profiles ?? [])
    .filter((profile) => profile.kind === 'clone' && Boolean(profile.ref_audio_path))
    .sort(
      (a, b) => (easyDate(b.created_at)?.getTime() ?? 0) - (easyDate(a.created_at)?.getTime() ?? 0),
    );
}

/** 느리게 / 보통 / 빠르게 → the speaking-rate multiplier sent with each take. */
export const EASY_SPEEDS = { slow: 0.85, normal: 1, fast: 1.2 } as const;
export type EasySpeed = keyof typeof EASY_SPEEDS;

export function easySpeedOf(speed: number): EasySpeed {
  if (speed < 0.95) return 'slow';
  if (speed > 1.05) return 'fast';
  return 'normal';
}

/** Longest text easy mode accepts in one take; long scripts belong to the full studio. */
export const EASY_MAX_CHARS = 2000;
