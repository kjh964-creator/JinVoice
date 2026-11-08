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

/** Slow / normal / fast → the speaking-rate multiplier sent with each take. */
export const EASY_SPEEDS = { slow: 0.85, normal: 1, fast: 1.2 } as const;
export type EasySpeed = keyof typeof EASY_SPEEDS;

export function easySpeedOf(speed: number): EasySpeed {
  if (speed < 0.95) return 'slow';
  if (speed > 1.05) return 'fast';
  return 'normal';
}

/**
 * Longest text easy mode accepts in one take. The backend reads long text in
 * ~800-character pieces by itself; longer writing belongs to the read-long-text page (the
 * easy audiobook), which renders and saves it chapter by chapter.
 */
export const EASY_MAX_CHARS = 5000;

/** From this length on, the make-speech page points to the audiobook page. */
export const EASY_LONG_TEXT_HINT = 4000;
