import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  BookOpenTextIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  DownloadIcon,
  FileTextIcon,
  ListOrderedIcon,
  MicIcon,
  PlusIcon,
  RotateCcwIcon,
  SettingsIcon,
  SquareIcon,
  Trash2Icon,
  XCircleIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { formatRuntimeClock } from '@shared/utils/audiobookScript';
import { getBridge } from '@/components/bridge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ConfirmDialog } from '@/features/clone/confirm-dialog';
import { useProfiles } from '@/hooks/use-profiles';
import { useTtsReadiness } from '@/hooks/use-tts-readiness';
import { apiJson, apiPath, describeError, profileAudioUrl } from '@/lib/api/client';
import { EASY_ROUTES } from '@/lib/easy-mode';
import { saveExport } from '@/lib/export-history';
import { runRendererTask } from '@/lib/global-error-recovery';
import { tr } from '@/lib/i18n-text';
import { cn } from '@/lib/utils';
import {
  easyDate,
  easySafeFileName,
  saveEasyAudioFile,
  saveEasyAudioSlice,
  type EasyPlayRange,
} from './easy-audio';
import {
  EASY_BOOK_MAX_CHAPTERS,
  EASY_BOOK_MAX_FILE_BYTES,
  EASY_BOOK_PART_CHARS,
  canRetryEasyBook,
  clearEasyBookResult,
  decodeEasyText,
  easyBookChapters,
  easyBookPreview,
  easyBookScript,
  easyChapterRanges,
  resumeEasyBook,
  retryEasyBook,
  startEasyBook,
  stopEasyBook,
  useEasyBook,
  type EasyBookChapterState,
  type EasyChapterStatus,
} from './easy-audiobook';
import { EasyEmpty, EasyPage, EasyPlayButton, EasySection } from './easy-layout';
import { EasySpeedPicker, EasyVoiceTile } from './easy-voice-tile';
import { easyVoices } from './easy-voices';

interface ResumableJob {
  job_id: string;
  type: string;
  title: string;
  chapters_done: number;
  total_chapters: number;
}

const DRAFT_KEY = 'jinvoice.easy-audiobook.draft.v1';

interface Draft {
  title: string;
  text: string;
  voiceId: string | null;
  speed: number;
}

function readDraft(): Draft {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (saved && typeof saved.text === 'string')
      return {
        title: typeof saved.title === 'string' ? saved.title : '',
        text: saved.text,
        voiceId: typeof saved.voiceId === 'string' ? saved.voiceId : null,
        speed: typeof saved.speed === 'number' ? saved.speed : 1,
      };
  } catch {
    /* A broken draft only means an empty page. */
  }
  return { title: '', text: '', voiceId: null, speed: 1 };
}

function StatusBadge({ status }: { status: EasyChapterStatus }) {
  const { t } = useTranslation();
  const Icon =
    status === 'done'
      ? CheckCircle2Icon
      : status === 'failed'
        ? XCircleIcon
        : status === 'rendering'
          ? Spinner
          : CircleDashedIcon;
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-medium',
        status === 'done' && 'bg-success/12 text-success',
        status === 'failed' && 'bg-destructive/10 text-destructive',
        status === 'rendering' && 'bg-primary/12 text-primary',
        status === 'pending' && 'bg-muted text-muted-foreground',
      )}
    >
      <Icon className="size-4" />
      {t(`easy.status_${status}`)}
    </span>
  );
}

function ChapterNumber({ n }: { n: number }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground tabular-nums max-sm:size-7 max-sm:text-[13px]">
      {n}
    </span>
  );
}

function chapterTitle(chapter: { title: string }, index: number) {
  return chapter.title || tr('easy.book_part', { n: index + 1 });
}

function ProgressList({ chapters }: { chapters: EasyBookChapterState[] }) {
  const { t } = useTranslation();
  return (
    <ol
      data-slot="easy-book-progress"
      aria-label={t('easy.book_preview_title')}
      className="studio-scrollbar flex max-h-80 flex-col divide-y divide-border/60 overflow-y-auto rounded-xl border border-border/70 bg-card"
    >
      {chapters.map((chapter, index) => (
        <li
          key={index}
          className="flex items-center gap-3 px-4 py-3 max-sm:gap-2.5 max-sm:px-3 max-sm:py-2.5"
        >
          <ChapterNumber n={index + 1} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-medium">
              {chapterTitle(chapter, index)}
            </span>
            {chapter.status === 'failed' && chapter.error && (
              <span className="block truncate text-sm text-muted-foreground">{chapter.error}</span>
            )}
          </span>
          {chapter.durationMs ? (
            <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
              {formatRuntimeClock(chapter.durationMs / 1000)}
            </span>
          ) : null}
          <StatusBadge status={chapter.status} />
        </li>
      ))}
    </ol>
  );
}

export function EasyAudiobookPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const book = useEasyBook();
  const profiles = useProfiles();
  const voices = easyVoices(profiles.data);
  const dateFormat = new Intl.DateTimeFormat(i18n.language || undefined, { dateStyle: 'medium' });
  const ttsBlocker = useTtsReadiness('audiobook');
  const [draft, setDraft] = useState<Draft>(readDraft);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = book.phase === 'running' || book.phase === 'assembling';

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } catch {
        /* Very long text may not fit in storage; it still works this session. */
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const selectedVoice = voices.find((voice) => voice.id === draft.voiceId) ?? null;
  useEffect(() => {
    if (!profiles.data) return;
    if (!selectedVoice && voices[0])
      setDraft((current) => ({ ...current, voiceId: voices[0]!.id }));
  }, [profiles.data, selectedVoice, voices]);

  const jobs = useQuery({
    queryKey: ['easy-audiobook-jobs'],
    queryFn: ({ signal }) => apiJson<{ jobs: ResumableJob[] }>('/audiobook/jobs', { signal }),
  });
  const refetchJobs = jobs.refetch;
  useEffect(() => {
    if (!busy) void refetchJobs();
  }, [busy, book.phase, refetchJobs]);
  const resumable = busy ? [] : (jobs.data?.jobs ?? []);
  const [deletingJob, setDeletingJob] = useState<ResumableJob | null>(null);

  const deferredText = useDeferredValue(draft.text);
  const labels = useMemo(
    () => ({ part: (n: number) => t('easy.book_part', { n }), intro: t('easy.book_intro') }),
    [t],
  );
  const script = useMemo(() => easyBookScript(deferredText, labels), [deferredText, labels]);
  const preview = useMemo(() => easyBookPreview(script), [script]);

  const needsSetup = ttsBlocker === 'engine';
  const hasText = draft.text.trim().length > 0;
  const hasVoice = Boolean(selectedVoice);
  const tooMany = preview.length > EASY_BOOK_MAX_CHAPTERS;
  const ready = hasText && hasVoice && !tooMany && ttsBlocker === null && !busy;

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  const openFile = async (file: File) => {
    setFileError(null);
    if (file.size > EASY_BOOK_MAX_FILE_BYTES) {
      setFileError(t('easy.book_file_too_big'));
      return;
    }
    try {
      const text = decodeEasyText(new Uint8Array(await file.arrayBuffer()));
      const name = file.name.replace(/\.[^.]+$/, '');
      setDraft((current) => ({ ...current, text, title: current.title || name }));
      toast.success(t('easy.book_file_loaded', { name: file.name }));
    } catch (error) {
      setFileError(t('easy.book_file_failed', { message: describeError(error) }));
    }
  };

  const start = () => {
    if (!ready) return;
    const fullScript = easyBookScript(draft.text, labels);
    void startEasyBook({
      title: draft.title.trim(),
      chapters: easyBookChapters(fullScript, draft.voiceId, draft.speed),
      voiceId: draft.voiceId,
    });
  };

  const openRegister = () =>
    runRendererTask('Open voice registration', () => navigate({ to: EASY_ROUTES.newVoice }));
  const openSettings = () =>
    runRendererTask('Open settings', () => navigate({ to: '/settings/models' }));

  const bookName = easySafeFileName(book.title, 'JinVoice-audiobook');
  const outputUrl = book.output ? apiPath('/audio/' + encodeURIComponent(book.output)) : null;
  const ranges = easyChapterRanges(book.chapters);
  const failedCount = book.chapters.filter((chapter) => chapter.status === 'failed').length;
  const doneCount = book.chapters.filter((chapter) => chapter.status === 'done').length;
  const totalMs = book.chapters.reduce((sum, chapter) => sum + (chapter.durationMs ?? 0), 0);

  const saveAll = async () => {
    if (!book.output || !outputUrl) return;
    const extension = book.output.split('.').pop() || 'mp3';
    const name = `${bookName}.${extension}`;
    if (getBridge()) {
      try {
        const saved = await saveExport(outputUrl, name);
        if (saved && !saved.canceled) toast.success(t('easy.saved'));
      } catch (error) {
        toast.error(t('easy.save_failed', { message: describeError(error) }));
      }
    } else await saveEasyAudioFile(book.output, name);
  };

  const rangeSeconds = (range: { start: number; end: number }): EasyPlayRange => ({
    start: range.start / 1000,
    end: range.end / 1000,
  });

  return (
    <EasyPage title={t('easy.audiobook_title')}>
      <div className="flex flex-col gap-4 max-sm:gap-3">
        {needsSetup && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-4 rounded-2xl border border-warning/40 bg-warning/10 p-5 max-sm:gap-3 max-sm:p-4"
          >
            <CircleAlertIcon className="size-6 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold">{t('easy.setup_needed_title')}</p>
              <p className="text-[15px] text-muted-foreground">{t('easy.setup_needed_body')}</p>
            </div>
            <Button className="h-11 gap-2 rounded-xl px-4 text-[15px]" onClick={openSettings}>
              <SettingsIcon className="size-4" />
              {t('easy.open_settings')}
            </Button>
          </div>
        )}

        {resumable.map((job) => (
          <div
            key={job.job_id}
            data-slot="easy-book-resume"
            className="flex flex-wrap items-center gap-4 rounded-2xl border border-primary/30 bg-primary/5 p-5 max-sm:gap-3 max-sm:p-4"
          >
            <RotateCcwIcon className="size-6 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold">{t('easy.book_resume_title')}</p>
              <p className="truncate text-[15px] text-muted-foreground">
                {t('easy.book_resume_body', {
                  title: job.title || t('easy.book_untitled'),
                  done: job.chapters_done,
                  total: job.total_chapters,
                })}
              </p>
            </div>
            <Button
              className="h-11 gap-2 rounded-xl px-4 text-[15px]"
              disabled={ttsBlocker !== null}
              onClick={() => void resumeEasyBook(job.job_id, job.title)}
            >
              {t('easy.book_resume')}
            </Button>
            <Button
              variant="ghost"
              data-slot="easy-book-delete"
              className="h-11 gap-2 rounded-xl px-3 text-[15px] text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setDeletingJob(job)}
            >
              <Trash2Icon className="size-4" />
              {t('easy.delete')}
            </Button>
          </div>
        ))}
        <ConfirmDialog
          open={deletingJob !== null}
          onOpenChange={(open) => !open && setDeletingJob(null)}
          title={t('easy.book_delete_title')}
          description={t('easy.book_delete_body', {
            title: deletingJob?.title || t('easy.book_untitled'),
          })}
          confirmLabel={t('easy.delete')}
          cancelLabel={t('easy.cancel')}
          onConfirm={async () => {
            if (!deletingJob) return;
            try {
              await apiJson(`/audiobook/jobs/${encodeURIComponent(deletingJob.job_id)}`, {
                method: 'DELETE',
              });
              toast.success(t('easy.book_deleted'));
            } catch (error) {
              toast.error(t('easy.delete_failed', { message: describeError(error) }));
            } finally {
              setDeletingJob(null);
              void refetchJobs();
            }
          }}
        />

        {busy && (
          <section
            role="status"
            aria-live="polite"
            data-slot="easy-book-running"
            className="flex flex-col gap-4 rounded-2xl border border-primary/30 bg-primary/5 p-5 sm:p-6 max-sm:gap-3 max-sm:p-4"
          >
            <div className="flex items-center gap-4">
              <Spinner className="size-8 shrink-0 text-primary" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-lg font-semibold">
                  {book.phase === 'assembling' ? t('easy.book_assembling') : t('easy.book_making')}
                </p>
                <p className="text-[15px] text-muted-foreground">
                  {t('easy.book_making_count', {
                    done: doneCount + failedCount,
                    total: book.chapters.length || '…',
                  })}
                </p>
              </div>
              <Button
                variant="outline"
                className="h-11 gap-2 rounded-xl px-4 text-[15px]"
                onClick={stopEasyBook}
              >
                <SquareIcon className="size-4" />
                {t('easy.book_stop')}
              </Button>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{
                  width: `${book.chapters.length ? Math.round(((doneCount + failedCount) / book.chapters.length) * 100) : 0}%`,
                }}
              />
            </div>
            {book.chapters.length > 0 && <ProgressList chapters={book.chapters} />}
            <p className="text-sm text-muted-foreground">{t('easy.book_keep_going')}</p>
          </section>
        )}

        {(book.phase === 'stopped' || book.phase === 'error') && (
          <section
            role={book.phase === 'error' ? 'alert' : 'status'}
            data-slot="easy-book-stopped"
            className={cn(
              'flex flex-col gap-4 rounded-2xl border p-5 sm:p-6 max-sm:gap-3 max-sm:p-4',
              book.phase === 'error'
                ? 'border-destructive/40 bg-destructive/8'
                : 'border-border/70 bg-card',
            )}
          >
            <div className="flex items-start gap-3">
              <CircleAlertIcon
                className={cn(
                  'mt-0.5 size-6 shrink-0',
                  book.phase === 'error' ? 'text-destructive' : 'text-muted-foreground',
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="text-base font-semibold">
                  {book.phase === 'error'
                    ? t('easy.book_error_title')
                    : t('easy.book_stopped_title')}
                </p>
                <p className="text-sm break-words text-muted-foreground">
                  {book.phase === 'error' ? book.error : t('easy.book_stopped_body')}
                </p>
              </div>
            </div>
            {book.chapters.length > 0 && <ProgressList chapters={book.chapters} />}
            {canRetryEasyBook() && (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  className="h-11 gap-2 rounded-xl px-4 text-[15px]"
                  disabled={ttsBlocker !== null}
                  onClick={() => void retryEasyBook()}
                >
                  <RotateCcwIcon className="size-4" />
                  {t('easy.book_retry')}
                </Button>
                <span className="text-sm text-muted-foreground">{t('easy.book_retry_hint')}</span>
              </div>
            )}
          </section>
        )}

        {book.phase === 'done' && book.output && (
          <section
            data-slot="easy-book-result"
            aria-label={t('easy.book_done_title')}
            className="flex flex-col gap-5 rounded-2xl border border-success/40 bg-success/8 p-5 sm:p-6 max-sm:gap-3 max-sm:p-3.5"
          >
            <div className="flex items-center gap-3">
              <CheckCircle2Icon className="size-7 shrink-0 text-success" />
              <div className="min-w-0">
                <p className="text-lg font-semibold">{t('easy.book_done_title')}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {[
                    book.title,
                    t('easy.book_done_meta', {
                      n: doneCount,
                      time: formatRuntimeClock(totalMs / 1000),
                    }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 max-sm:grid max-sm:grid-cols-2">
              <EasyPlayButton
                playKey={`book:${book.output}`}
                src={outputUrl}
                label={t('easy.book_play_all')}
                size="large"
              />
              <Button
                variant="outline"
                className="h-12 gap-2 rounded-xl px-5 text-base max-sm:h-11 max-sm:px-3 max-sm:text-[15px]"
                onClick={() => void saveAll()}
              >
                <DownloadIcon className="size-5" />
                {t('easy.book_save_all')}
              </Button>
              <Button
                variant="ghost"
                className="h-12 gap-2 rounded-xl px-5 text-base max-sm:col-span-2 max-sm:h-10 max-sm:text-[15px]"
                onClick={clearEasyBookResult}
              >
                <PlusIcon className="size-5" />
                {t('easy.book_new')}
              </Button>
            </div>
            {failedCount > 0 && (
              <div className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/30 bg-background/70 px-4 py-3">
                <CircleAlertIcon className="size-5 shrink-0 text-destructive" />
                <span className="min-w-0 flex-1 text-[15px]">
                  {t('easy.book_failed_chapters', { n: failedCount })}
                </span>
                {canRetryEasyBook() && (
                  <Button
                    variant="outline"
                    className="h-10 gap-2 rounded-xl px-4 text-[15px]"
                    disabled={ttsBlocker !== null}
                    onClick={() => void retryEasyBook()}
                  >
                    <RotateCcwIcon className="size-4" />
                    {t('easy.book_retry')}
                  </Button>
                )}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <h2 className="text-base font-semibold">{t('easy.book_chapters_title')}</h2>
              <ol
                data-slot="easy-book-chapters"
                className="studio-scrollbar flex max-h-[26rem] flex-col divide-y divide-border/60 overflow-y-auto rounded-xl border border-border/70 bg-card"
              >
                {book.chapters.map((chapter, index) => {
                  const range = ranges[index];
                  const title = chapterTitle(chapter, index);
                  return (
                    <li
                      key={index}
                      className="flex items-center gap-3 px-4 py-2.5 max-sm:gap-2 max-sm:px-3 max-sm:py-2"
                    >
                      <ChapterNumber n={index + 1} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium">{title}</span>
                        <span className="block text-sm text-muted-foreground tabular-nums">
                          {range
                            ? formatRuntimeClock((range.end - range.start) / 1000)
                            : t('easy.book_chapter_missing')}
                        </span>
                      </span>
                      {range ? (
                        <>
                          <EasyPlayButton
                            playKey={`book:${book.output}:${index}`}
                            src={outputUrl}
                            range={rangeSeconds(range)}
                            size="icon"
                          />
                          <Button
                            variant="outline"
                            className="size-11 rounded-full max-sm:size-10"
                            aria-label={t('easy.book_save_chapter')}
                            title={t('easy.book_save_chapter')}
                            onClick={() =>
                              book.output &&
                              void saveEasyAudioSlice(
                                book.output,
                                rangeSeconds(range),
                                `${bookName} - ${String(index + 1).padStart(2, '0')} ${easySafeFileName(title, '')}`.trim() +
                                  '.wav',
                              )
                            }
                          >
                            <DownloadIcon className="size-5" />
                          </Button>
                        </>
                      ) : (
                        <StatusBadge status="failed" />
                      )}
                    </li>
                  );
                })}
              </ol>
            </div>
          </section>
        )}

        {!busy && book.phase !== 'done' && (
          <div className="grid min-w-0 items-start gap-4 max-sm:gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            <div className="min-w-0">
              <EasySection
                step={1}
                title={t('easy.book_step_text')}
                hint={
                  <span aria-live="polite" className="tabular-nums">
                    {t('easy.book_char_count', { n: draft.text.length.toLocaleString() })}
                  </span>
                }
              >
                <div className="flex flex-col gap-3">
                  <Input
                    aria-label={t('easy.book_title_label')}
                    value={draft.title}
                    onChange={(event) => set({ title: event.target.value })}
                    placeholder={t('easy.book_title_placeholder')}
                    className="h-12 rounded-xl px-4 text-base md:text-base max-sm:h-11 max-sm:px-3.5 max-sm:text-[15px]"
                  />
                  <div className="flex flex-wrap items-center gap-3 max-sm:flex-nowrap max-sm:gap-2.5">
                    <Button
                      variant="outline"
                      className="h-11 gap-2 rounded-xl px-4 text-[15px] max-sm:h-10 max-sm:px-3 max-sm:text-sm"
                      onClick={() => fileInput.current?.click()}
                    >
                      <FileTextIcon className="size-5 max-sm:size-4" />
                      {t('easy.book_open_file')}
                    </Button>
                    <span className="text-sm text-muted-foreground max-sm:text-[12.5px] max-sm:leading-snug">
                      {t('easy.book_file_hint')}
                    </span>
                    <input
                      ref={fileInput}
                      type="file"
                      accept=".txt,.md,text/plain"
                      aria-label={t('easy.book_open_file')}
                      className="hidden"
                      data-testid="easy-book-file"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (file) void openFile(file);
                      }}
                    />
                  </div>
                  {fileError && (
                    <p role="alert" className="text-sm text-destructive">
                      {fileError}
                    </p>
                  )}
                  <Textarea
                    aria-label={t('easy.book_step_text')}
                    value={draft.text}
                    onChange={(event) => set({ text: event.target.value })}
                    placeholder={t('easy.book_text_placeholder')}
                    className="max-h-[28rem] min-h-40 rounded-xl px-4 py-3 text-base leading-relaxed md:text-base lg:max-h-40 max-sm:max-h-80 max-sm:min-h-36 max-sm:px-3.5 max-sm:py-2.5 max-sm:text-[15px]"
                  />
                  <p className="text-sm text-muted-foreground max-sm:text-[13px]">
                    {t('easy.book_limit', { max: EASY_BOOK_MAX_CHAPTERS.toLocaleString() })}
                  </p>

                  <div
                    data-slot="easy-book-preview"
                    className="flex flex-col gap-2 rounded-xl border border-border/60 bg-muted/50 p-3 max-sm:gap-2 max-sm:p-3"
                  >
                    <div className="flex items-center gap-2">
                      <ListOrderedIcon className="size-5 text-primary" />
                      <h3 className="text-[15px] font-semibold">{t('easy.book_preview_title')}</h3>
                      {preview.length > 0 && (
                        <span className="ms-auto text-sm font-medium text-primary">
                          {t('easy.book_preview_count', { n: preview.length.toLocaleString() })}
                        </span>
                      )}
                    </div>
                    {preview.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {t('easy.book_preview_empty')}
                      </p>
                    ) : (
                      <ol className="studio-scrollbar flex max-h-64 flex-col gap-1.5 overflow-y-auto lg:max-h-32">
                        {preview.slice(0, 200).map((chapter, index) => (
                          <li
                            key={index}
                            className="flex items-center gap-3 rounded-lg border border-border/60 bg-background px-3 py-2 shadow-xs max-sm:gap-2.5 max-sm:py-1.5"
                          >
                            <ChapterNumber n={index + 1} />
                            <span className="min-w-0 flex-1 truncate text-[15px]">
                              {chapter.title}
                            </span>
                            <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                              {t('easy.book_char_count', { n: chapter.chars.toLocaleString() })}
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                    <p className="text-sm text-muted-foreground max-sm:text-[13px]">
                      {t('easy.book_split_hint', { n: EASY_BOOK_PART_CHARS.toLocaleString() })}
                    </p>
                  </div>
                </div>
              </EasySection>
            </div>
            <div className="flex min-w-0 flex-col gap-4 max-sm:gap-3">
              <EasySection step={2} title={t('easy.step_voice')}>
                {profiles.isLoading ? (
                  <div className="flex items-center gap-2 py-6 text-muted-foreground">
                    <Spinner className="size-5" />
                    {t('easy.loading')}
                  </div>
                ) : voices.length === 0 ? (
                  <EasyEmpty
                    icon={<MicIcon />}
                    title={t('easy.no_voices_title')}
                    description={t('easy.no_voices_create')}
                    action={
                      <Button
                        className="h-12 gap-2 rounded-xl px-5 text-base"
                        onClick={openRegister}
                      >
                        <PlusIcon className="size-5" />
                        {t('easy.register_voice')}
                      </Button>
                    }
                  />
                ) : (
                  <div
                    role="radiogroup"
                    aria-label={t('easy.step_voice')}
                    className="grid gap-3 sm:grid-cols-2 max-sm:grid-cols-2 max-sm:gap-2"
                  >
                    {voices.map((voice) => (
                      <EasyVoiceTile
                        key={voice.id}
                        name={voice.name}
                        imageUrl={voice.image_url}
                        subtitle={
                          easyDate(voice.created_at)
                            ? t('easy.registered_on', {
                                date: dateFormat.format(easyDate(voice.created_at)!),
                              })
                            : t('easy.my_voice')
                        }
                        selected={voice.id === draft.voiceId}
                        onSelect={() => set({ voiceId: voice.id })}
                        playKey={`voice:${voice.id}`}
                        playSrc={profileAudioUrl(voice.id, voice.audio_url)}
                      />
                    ))}
                  </div>
                )}
              </EasySection>

              <EasySection step={3} title={t('easy.step_speed')}>
                <EasySpeedPicker speed={draft.speed} onChange={(speed) => set({ speed })} />
              </EasySection>

              <div className="flex flex-col items-stretch gap-2">
                <Button
                  data-slot="easy-book-start"
                  className="h-14 gap-3 rounded-2xl text-lg font-semibold max-sm:h-13 max-sm:gap-2 max-sm:text-[17px]"
                  disabled={!ready}
                  onClick={start}
                >
                  <BookOpenTextIcon className="size-6" />
                  {t('easy.book_start')}
                </Button>
                {!ready && !needsSetup && (
                  <p className="text-center text-sm text-muted-foreground">
                    {!hasText
                      ? t('easy.book_need_text')
                      : !hasVoice
                        ? t('easy.need_voice')
                        : tooMany
                          ? t('easy.book_too_many', { max: EASY_BOOK_MAX_CHAPTERS })
                          : ttsBlocker === 'loading'
                            ? t('easy.getting_ready')
                            : null}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </EasyPage>
  );
}
