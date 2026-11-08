import { useSyncExternalStore } from 'react';
import { DEFAULT_OVERRIDES, overridesToRequest } from '@shared/utils/longformOverrides';
import { parseScriptToSpans, type LongformParsedChapter } from '@shared/utils/longformParser';
import { consumeLongformStream } from '@shared/utils/longformStream';
import { decodeTextBytes } from '@shared/utils/readTextFile';
import { apiFetch, describeError } from '@/lib/api/client';
import { publicFailureFromEvent } from '@/lib/api/failure';
import { beginAppActivity } from '@/lib/app-activity';

/**
 * JinVoice "read long text" (easy audiobook): plain text in, one finished book out.
 *
 * Everything heavy is upstream's: the chapter grammar (`# heading` lines,
 * parsed by the JS twin of the backend parser), the shared chapterized
 * renderer behind `POST /longform/render` (per-chapter cache, durable resume,
 * one merged file), `GET /audiobook/jobs` + `POST /audiobook/resume/{id}` for
 * interrupted books, and `/audio/<output>` for the finished file. This module
 * only turns pasted prose into that grammar and keeps the progress in a store
 * that outlives the page, so leaving and coming back keeps the book going.
 */

/** Upstream's render cap (`_MAX_CHAPTERS` in the audiobook router). */
export const EASY_BOOK_MAX_CHAPTERS = 10_000;
/** Upstream's import cap for a manuscript file (`_IMPORT_MAX_BYTES`). */
export const EASY_BOOK_MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Prose without chapter lines is cut into parts of about this many characters. */
export const EASY_BOOK_PART_CHARS = 3000;

// A Markdown H1, the same rule as the backend parser.
const HEADING_RE = /^[ \t]*#[ \t]+\S/m;
// Short standalone lines that open a chapter: "Chapter 3", "Part II",
// "Prologue", and the Korean forms (je-N-jang/hwa/bu/pyeon/jeol, N-jang,
// prologue, epilogue, foreword, preface, afterword), written as escapes.
const CHAPTER_LINE_RE = new RegExp(
  '^(?:' +
    [
      '\\uC81C\\s*\\d+\\s*[\\uC7A5\\uD654\\uBD80\\uD3B8\\uC808]',
      '\\d+\\s*[\\uC7A5\\uD654]',
      'chapter\\s+\\S+',
      'part\\s+\\S+',
      'prologue',
      'epilogue',
      '\\uD504\\uB864\\uB85C\\uADF8',
      '\\uC5D0\\uD544\\uB85C\\uADF8',
      '\\uC11C\\uBB38',
      '\\uBA38\\uB9AC\\uB9D0',
      '\\uB9FA\\uC74C\\uB9D0',
    ].join('|') +
    ')(?=$|[\\s.:)\\]-])',
  'i',
);
const CHAPTER_TITLE_MAX = 60;
// Sentence ends (Latin and CJK full stops) for cutting one huge paragraph.
const SENTENCE_END_RE = /(?<=[.!?\u2026\u3002\uFF01\uFF1F])\s+/;

export interface EasyBookLabels {
  /** Title of an automatic part, e.g. "Part 3". */
  part: (n: number) => string;
  /** Title of the text before the first chapter line. */
  intro: string;
}

/** Decode a picked text file: BOM, UTF-8, then Korean CP949/EUC-KR, then upstream's fallback. */
export function decodeEasyText(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const bom =
    (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) ||
    (b[0] === 0xff && b[1] === 0xfe) ||
    (b[0] === 0xfe && b[1] === 0xff);
  if (bom) return decodeTextBytes(b);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    /* not UTF-8: try the Korean Windows code page next */
  }
  try {
    return new TextDecoder('euc-kr', { fatal: true }).decode(b);
  } catch {
    return decodeTextBytes(b);
  }
}

function splitLongParagraph(paragraph: string, limit: number): string[] {
  if (paragraph.length <= limit) return [paragraph];
  const pieces: string[] = [];
  let current = '';
  const sentences = paragraph
    .split('\n')
    .flatMap((line) => line.split(SENTENCE_END_RE))
    .filter((piece) => piece.trim());
  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > limit) {
      pieces.push(current);
      current = '';
    }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * Turn pasted prose into upstream's chapter script (`# title` lines).
 *
 * 1. Text that already has `# ` headings is the user's own structure: kept.
 * 2. Otherwise short lines such as "Chapter 3" (or the Korean je-3-jang form) become headings.
 * 3. Otherwise the text is cut at paragraph breaks into parts of about
 *    `EASY_BOOK_PART_CHARS` characters, so progress and resume work per part.
 */
export function easyBookScript(
  text: string,
  labels: EasyBookLabels,
  partChars = EASY_BOOK_PART_CHARS,
): string {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!normalized.trim()) return '';
  const withIntro = (script: string) => {
    const first = script.search(/^[ \t]*#[ \t]+\S/m);
    return first > 0 && script.slice(0, first).trim() ? `# ${labels.intro}\n${script}` : script;
  };
  if (HEADING_RE.test(normalized)) return withIntro(normalized);

  let found = false;
  const marked = normalized
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed && trimmed.length <= CHAPTER_TITLE_MAX && CHAPTER_LINE_RE.test(trimmed)) {
        found = true;
        return `# ${trimmed}`;
      }
      return line;
    })
    .join('\n');
  if (found) return withIntro(marked);

  const paragraphs = normalized
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .flatMap((paragraph) => splitLongParagraph(paragraph, partChars));
  const parts: string[][] = [];
  let size = 0;
  for (const paragraph of paragraphs) {
    const last = parts[parts.length - 1];
    if (!last || size + paragraph.length > partChars) {
      parts.push([paragraph]);
      size = paragraph.length;
    } else {
      last.push(paragraph);
      size += paragraph.length;
    }
  }
  return parts
    .map((part, index) => `# ${labels.part(index + 1)}\n${part.join('\n\n')}`)
    .join('\n\n');
}

export interface EasyBookPreviewChapter {
  title: string;
  chars: number;
}

/** The chapter list upstream's parser makes from `script`, for the preview. */
export function easyBookPreview(script: string): EasyBookPreviewChapter[] {
  return parseScriptToSpans(script).map((chapter) => ({
    title: chapter.title,
    chars: chapter.spans.reduce((sum, span) => sum + span.text.length, 0),
  }));
}

/** Upstream render chapters (with the chosen voice and speed on every span). */
export function easyBookChapters(
  script: string,
  voiceId: string | null,
  speed: number,
): LongformParsedChapter[] {
  return parseScriptToSpans(script, {
    defaultVoice: voiceId,
    // 1.0 is the engine default; leave it unset so the request stays upstream's.
    defaultSpeed: Math.abs(speed - 1) < 0.001 ? null : speed,
  });
}

export interface EasyBookRequest {
  title: string;
  chapters: LongformParsedChapter[];
  voiceId: string | null;
}

/** Body for upstream's `POST /longform/render` (same shape the Stories page sends). */
export function easyBookRenderBody({ title, chapters, voiceId }: EasyBookRequest) {
  return {
    ...overridesToRequest(DEFAULT_OVERRIDES, 'Auto'),
    chapters,
    default_voice: voiceId,
    voice_map: {},
    // MP3 plays everywhere (phones, cars, Windows); m4b needs a book player.
    format: 'mp3',
    language: 'Auto',
    metadata: title ? { title } : {},
    loudness: 'off',
    cover_path: null,
  };
}

// ── Progress store ──────────────────────────────────────────────────────────

export type EasyChapterStatus = 'pending' | 'rendering' | 'done' | 'failed';
export interface EasyBookChapterState {
  title: string;
  status: EasyChapterStatus;
  durationMs?: number;
  error?: string;
}
export type EasyBookPhase = 'idle' | 'running' | 'assembling' | 'done' | 'stopped' | 'error';
export interface EasyBookState {
  phase: EasyBookPhase;
  title: string;
  chapters: EasyBookChapterState[];
  completed: number;
  /** Server path of the merged file, served under `/audio/`. */
  output: string | null;
  error: string | null;
  /** True when the last start was a resume (no request to retry from). */
  resumed: boolean;
}

const RESULT_KEY = 'jinvoice.easy-audiobook.result.v1';
const blank: EasyBookState = {
  phase: 'idle',
  title: '',
  chapters: [],
  completed: 0,
  output: null,
  error: null,
  resumed: false,
};

function restoreResult(): EasyBookState {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(RESULT_KEY) || 'null');
    if (saved && typeof saved.output === 'string' && Array.isArray(saved.chapters))
      return {
        ...blank,
        phase: 'done',
        title: typeof saved.title === 'string' ? saved.title : '',
        output: saved.output,
        chapters: saved.chapters.filter(
          (chapter: EasyBookChapterState) => chapter && typeof chapter.title === 'string',
        ),
        completed: saved.chapters.length,
      };
  } catch {
    /* A broken saved result only means the last book is not shown. */
  }
  return { ...blank };
}

let state: EasyBookState = restoreResult();
const listeners = new Set<() => void>();
let controller: AbortController | null = null;
let lastRequest: EasyBookRequest | null = null;

function set(next: Partial<EasyBookState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function persistResult() {
  try {
    if (state.phase === 'done' && state.output)
      globalThis.localStorage?.setItem(
        RESULT_KEY,
        JSON.stringify({ title: state.title, output: state.output, chapters: state.chapters }),
      );
  } catch {
    /* Storage full: the result still shows until the app closes. */
  }
}

export function getEasyBookState(): EasyBookState {
  return state;
}

export function useEasyBook(): EasyBookState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
    () => state,
  );
}

export function isEasyBookBusy(): boolean {
  return controller !== null;
}

/** Forget the finished book on screen (the file stays on disk). */
export function clearEasyBookResult(): void {
  if (controller) return;
  try {
    globalThis.localStorage?.removeItem(RESULT_KEY);
  } catch {
    /* ignore */
  }
  set({ ...blank });
}

async function run(path: string, init: RequestInit, title: string, titles: string[]) {
  if (controller) return;
  const current = new AbortController();
  controller = current;
  const finishActivity = beginAppActivity('longform');
  let chapters: EasyBookChapterState[] = titles.map((chapterTitle) => ({
    title: chapterTitle,
    status: 'pending',
  }));
  set({
    phase: 'running',
    title,
    chapters,
    completed: 0,
    output: null,
    error: null,
    resumed: path.startsWith('/audiobook/resume/'),
  });
  let finished = false;
  try {
    const response = await apiFetch(path, { ...init, method: 'POST', signal: current.signal });
    await consumeLongformStream(
      response,
      (event) => {
        if (event.type === 'error') {
          throw new Error(publicFailureFromEvent(event, 'Render failed').reason);
        }
        if (event.type === 'started') {
          const total = Number(event.chapters) || chapters.length;
          chapters = Array.from({ length: total }, (_, index) => ({
            title: chapters[index]?.title ?? '',
            status: index === 0 ? 'rendering' : 'pending',
          }));
          set({ chapters });
        }
        if (event.type === 'chapter' || event.type === 'chapter_error') {
          const index = Number(event.index);
          if (!Number.isInteger(index) || index < 0 || index >= chapters.length) return;
          const failed = event.type === 'chapter_error';
          chapters = chapters.map((chapter, chapterIndex) => {
            if (chapterIndex === index)
              return {
                title: typeof event.title === 'string' && event.title ? event.title : chapter.title,
                status: failed ? 'failed' : 'done',
                ...(event.duration_ms != null && Number.isFinite(Number(event.duration_ms))
                  ? { durationMs: Number(event.duration_ms) }
                  : Number.isFinite(Number(event.duration_s))
                    ? { durationMs: Math.round(Number(event.duration_s) * 1000) }
                    : {}),
                ...(failed
                  ? {
                      error:
                        typeof event.reason === 'string'
                          ? event.reason
                          : typeof event.error === 'string'
                            ? event.error
                            : '',
                    }
                  : {}),
              };
            if (chapterIndex === index + 1 && chapter.status === 'pending')
              return { ...chapter, status: 'rendering' };
            return chapter;
          });
          set({ chapters, completed: index + 1 });
        }
        if (event.type === 'assembling') set({ phase: 'assembling' });
        if (event.type === 'stopped') {
          finished = true;
          set({ phase: 'stopped' });
        }
        if (event.type === 'done' && typeof event.output === 'string' && event.output) {
          finished = true;
          set({ phase: 'done', output: event.output, completed: chapters.length });
          persistResult();
        }
      },
      { signal: current.signal },
    );
    if (!finished && !current.signal.aborted)
      throw new Error('Render stream ended before completion');
    if (!finished) set({ phase: 'stopped' });
  } catch (error) {
    if (current.signal.aborted) set({ phase: 'stopped' });
    else set({ phase: 'error', error: describeError(error) });
  } finally {
    finishActivity();
    if (controller === current) controller = null;
    // A chapter still marked as in progress did not finish.
    if (state.phase !== 'done')
      set({
        chapters: state.chapters.map((chapter) =>
          chapter.status === 'rendering' ? { ...chapter, status: 'pending' } : chapter,
        ),
      });
  }
}

/** Start a new book through upstream's shared longform renderer. */
export function startEasyBook(request: EasyBookRequest): Promise<void> {
  lastRequest = request;
  return run(
    '/longform/render',
    {
      body: JSON.stringify(easyBookRenderBody(request)),
      headers: { 'Content-Type': 'application/json' },
    },
    request.title,
    request.chapters.map((chapter) => chapter.title),
  );
}

/** Continue an interrupted book; finished chapters come back from the cache at once. */
export function resumeEasyBook(jobId: string, title = ''): Promise<void> {
  return run('/audiobook/resume/' + encodeURIComponent(jobId), {}, title, []);
}

/**
 * Try again after failures or a stop: the same request again. The renderer's
 * chapter cache returns every finished chapter instantly, so only the missing
 * and failed ones are made again.
 */
export function retryEasyBook(): Promise<void> | null {
  return lastRequest ? startEasyBook(lastRequest) : null;
}

export function canRetryEasyBook(): boolean {
  return lastRequest !== null;
}

export function stopEasyBook(): void {
  controller?.abort();
}

/** Start/end (ms) of each finished chapter inside the merged file; failed ones are left out. */
export function easyChapterRanges(
  chapters: EasyBookChapterState[],
): ({ start: number; end: number } | null)[] {
  let offset = 0;
  return chapters.map((chapter) => {
    if (chapter.status !== 'done' || !chapter.durationMs) return null;
    const range = { start: offset, end: offset + chapter.durationMs };
    offset = range.end;
    return range;
  });
}

/** Test hook: reset the module state. */
export function resetEasyBookForTests(): void {
  controller?.abort();
  controller = null;
  lastRequest = null;
  state = restoreResult();
  for (const listener of listeners) listener();
}
