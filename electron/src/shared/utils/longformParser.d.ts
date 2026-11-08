export interface LongformParsedSpan {
  voice_id: string | null;
  text: string;
  pause_ms_after: number;
  speed: number | null;
  join?: 'continue' | 'paragraph';
}

export interface LongformParsedChapter {
  title: string;
  spans: LongformParsedSpan[];
}

export const PAUSE_DEFAULT_MS: number;
export const PAUSE_MAX_MS: number;
export function roundHalfToEven(x: number): number;
export function parseChapterBody(
  body: string,
  options?: { defaultVoice?: string | null; defaultSpeed?: number | null },
): LongformParsedSpan[];
export function parseScriptToSpans(
  text: string,
  options?: { defaultVoice?: string | null; defaultSpeed?: number | null },
): LongformParsedChapter[];
