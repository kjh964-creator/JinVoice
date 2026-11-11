import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleIcon,
  DownloadIcon,
  FileTextIcon,
  MicIcon,
  Music2Icon,
  PenLineIcon,
  PlusIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useProfiles } from '@/hooks/use-profiles';
import { ApiError, audioUrl, describeError, profileAudioUrl } from '@/lib/api/client';
import { EASY_ROUTES } from '@/lib/easy-mode';
import { runRendererTask } from '@/lib/global-error-recovery';
import { queryKeys } from '@/lib/query';
import { cn } from '@/lib/utils';
import { saveEasyAudioFile } from './easy-audio';
import { coverClock, coverMegabytes } from './easy-cover';
import { EasyEmpty, EasyPage, EasyPlayButton, EasySection } from './easy-layout';
import {
  STORY_GENRES,
  STORY_LENGTHS,
  STORY_MAX_CHARS,
  STORY_MAX_LYRICS,
  STORY_MIN_CHARS,
  STORY_STEPS,
  cancelStoryLyrics,
  cancelStorySongJob,
  cancelStorySongSetup,
  currentStoryJob,
  getStoryLyrics,
  isStoryActive,
  listStorySongJobs,
  loadStoryDraft,
  saveStoryDraft,
  saveStoryLyrics,
  startStoryLyrics,
  startStorySongJob,
  startStorySongSetup,
  storyErrorKey,
  storyLyricLines,
  storySongFileName,
  storySongSetup,
  type StoryDraft,
  type StoryGenre,
  type StoryLength,
  type StorySongJob,
} from './easy-story-song';
import { EasyVoiceTile } from './easy-voice-tile';
import { easyVoices } from './easy-voices';

const STORY_KEYS = {
  setup: ['story-song', 'setup'] as const,
  jobs: ['story-song', 'jobs'] as const,
  lyrics: (id: string) => ['story-song', 'lyrics', id] as const,
};

function apiErrorText(error: unknown, t: (key: string) => string): string {
  if (error instanceof ApiError) {
    const detail = (error.payload as { detail?: unknown } | null)?.detail;
    const code =
      detail && typeof detail === 'object' && 'code' in detail ? String(detail.code) : null;
    const key = storyErrorKey({ error_code: code });
    if (key) return t(key);
  }
  return describeError(error);
}

function SetupCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const setup = useQuery({
    queryKey: STORY_KEYS.setup,
    queryFn: storySongSetup,
    refetchInterval: (query) => (query.state.data?.install.state === 'running' ? 1000 : false),
  });
  const start = useMutation({
    mutationFn: startStorySongSetup,
    onSuccess: (data) => queryClient.setQueryData(STORY_KEYS.setup, data),
  });
  const cancel = useMutation({
    mutationFn: cancelStorySongSetup,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: STORY_KEYS.setup }),
  });
  const data = setup.data;
  if (!data || data.ready) return null;
  if (!data.supported)
    return (
      <p
        role="status"
        data-slot="easy-story-unsupported"
        className="rounded-2xl border border-border bg-muted/50 p-5 text-[15px] text-muted-foreground max-sm:p-3.5 max-sm:text-sm"
      >
        {t('easy.story_unsupported')}
      </p>
    );
  const running = data.install.state === 'running';
  return (
    <section
      data-slot="easy-story-setup"
      role="status"
      className="flex flex-col gap-4 rounded-2xl border border-primary/30 bg-primary/5 p-5 max-sm:gap-3 max-sm:p-3.5"
    >
      <div className="flex items-start gap-3">
        <DownloadIcon className="mt-0.5 size-6 shrink-0 text-primary max-sm:size-5" />
        <div className="min-w-0">
          <p className="text-base font-semibold">{t('easy.cover_setup_title')}</p>
          <p className="text-[15px] text-muted-foreground max-sm:text-sm">
            {t('easy.story_setup_body', {
              size: coverMegabytes(data.missing_bytes || data.total_bytes),
            })}
          </p>
        </div>
      </div>
      {running ? (
        <div className="flex flex-col gap-2">
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${data.install.percent}%` }}
            />
          </div>
          <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>
              {t('easy.cover_setup_downloading', { percent: Math.floor(data.install.percent) })}
            </span>
            <Button
              variant="outline"
              className="h-10 rounded-xl px-4 text-[15px]"
              onClick={() => cancel.mutate()}
            >
              {t('easy.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {data.install.state === 'error' && (
            <p className="text-sm break-words text-destructive">
              {t('easy.cover_setup_failed', { message: data.install.error ?? '' })}
            </p>
          )}
          <Button
            data-slot="easy-story-setup-button"
            className="h-12 gap-2 self-start rounded-xl px-5 text-base max-sm:w-full"
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            <DownloadIcon className="size-5" />
            {t('easy.cover_setup_button')}
          </Button>
        </div>
      )}
    </section>
  );
}

function ChoiceGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  labelOf,
  columns,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  labelOf: (value: T) => string;
  columns: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('grid gap-2 rounded-2xl bg-muted/60 p-1.5 max-sm:gap-1 max-sm:p-1', columns)}
    >
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={active}
            data-value={option}
            onClick={() => onChange(option)}
            className={cn(
              'h-12 rounded-xl px-2 text-base font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 max-sm:h-10 max-sm:text-[15px]',
              active
                ? 'bg-background text-foreground shadow-sm ring-1 ring-border'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {labelOf(option)}
          </button>
        );
      })}
    </div>
  );
}

function SongProgress({ job, onCancel }: { job: StorySongJob; onCancel: () => void }) {
  const { t } = useTranslation();
  const current = STORY_STEPS.indexOf(job.step);
  return (
    <section
      data-slot="easy-story-progress"
      role="status"
      aria-live="polite"
      className="flex flex-col gap-4 rounded-2xl border border-primary/30 bg-primary/5 px-6 py-6 max-sm:gap-3 max-sm:px-3.5 max-sm:py-4"
    >
      <div className="flex items-center gap-3">
        <Spinner className="size-8 shrink-0 text-primary max-sm:size-7" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-lg font-semibold max-sm:text-[17px]">{t('easy.cover_making')}</p>
          <p className="truncate text-sm text-muted-foreground">
            {job.title} · {job.profile_name}
          </p>
        </div>
        <span className="shrink-0 text-2xl font-semibold tabular-nums text-primary max-sm:text-xl">
          {Math.floor(job.percent)}%
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${job.percent}%` }}
        />
      </div>
      <ol className="flex flex-col gap-1.5 max-sm:gap-1">
        {STORY_STEPS.map((step, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li
              key={step}
              data-state={done ? 'done' : active ? 'active' : 'waiting'}
              className={cn(
                'flex items-center gap-2.5 text-[15px] max-sm:text-sm',
                done && 'text-muted-foreground',
                active && 'font-semibold text-foreground',
                !done && !active && 'text-muted-foreground/70',
              )}
            >
              {done ? (
                <CheckCircle2Icon className="size-5 shrink-0 text-success max-sm:size-4" />
              ) : active ? (
                <Spinner className="size-5 shrink-0 text-primary max-sm:size-4" />
              ) : (
                <CircleIcon className="size-5 shrink-0 max-sm:size-4" />
              )}
              <span className="min-w-0 flex-1">{t(`easy.story_step_${step}`)}</span>
              {active && step !== 'preparing' && (
                <span className="tabular-nums">{Math.floor(job.step_percent)}%</span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="text-sm text-muted-foreground">
        {t('easy.cover_elapsed', { time: coverClock(job.elapsed_s) })}
        {' · '}
        {t('easy.cover_leave_ok')}
      </p>
      <div>
        <Button
          variant="outline"
          className="h-11 rounded-xl px-5 text-[15px] max-sm:w-full"
          onClick={onCancel}
        >
          {t('easy.cancel')}
        </Button>
      </div>
    </section>
  );
}

function SongResult({ job, onNew }: { job: StorySongJob; onNew: () => void }) {
  const { t } = useTranslation();
  const result = job.result;
  if (!result) return null;
  const buttonClass =
    'h-12 gap-2 rounded-xl px-5 text-base max-sm:h-11 max-sm:px-3 max-sm:text-[15px]';
  return (
    <section
      data-slot="easy-story-result"
      aria-label={t('easy.cover_done')}
      className="flex flex-col gap-4 rounded-2xl border border-success/40 bg-success/8 p-5 sm:p-6 max-sm:gap-3 max-sm:p-3.5"
    >
      <div className="flex items-center gap-3 max-sm:gap-2.5">
        <CheckCircle2Icon className="size-7 shrink-0 text-success max-sm:size-6" />
        <div className="min-w-0">
          <p className="text-lg font-semibold max-sm:text-[17px]">{t('easy.cover_done')}</p>
          <p className="truncate text-sm text-muted-foreground">
            {t('easy.cover_done_meta', {
              voice: job.profile_name,
              song: job.title,
              time: coverClock(result.duration_s),
            })}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-xl bg-background/60 p-3 ring-1 ring-border/60 max-sm:p-2.5">
        <p className="text-[15px] font-semibold max-sm:text-sm">
          {t('easy.story_take_voice', { voice: job.profile_name })}
        </p>
        <div className="flex flex-wrap gap-2 max-sm:grid max-sm:grid-cols-2">
          <EasyPlayButton
            playKey={`story:${result.id}`}
            src={audioUrl(result.audio_path)}
            size="large"
          />
          <Button
            variant="outline"
            className={buttonClass}
            onClick={() => void saveEasyAudioFile(result.audio_path, storySongFileName(job, false))}
          >
            <DownloadIcon className="size-5" />
            {t('easy.save_file')}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-xl bg-background/60 p-3 ring-1 ring-border/60 max-sm:p-2.5">
        <p className="text-[15px] font-semibold max-sm:text-sm">{t('easy.story_take_ai')}</p>
        <div className="flex flex-wrap gap-2 max-sm:grid max-sm:grid-cols-2">
          <EasyPlayButton
            playKey={`story-ai:${result.ai_id}`}
            src={audioUrl(result.ai_audio_path)}
          />
          <Button
            variant="outline"
            className={buttonClass}
            onClick={() =>
              void saveEasyAudioFile(result.ai_audio_path, storySongFileName(job, true))
            }
          >
            <DownloadIcon className="size-5" />
            {t('easy.save_file')}
          </Button>
        </div>
      </div>

      <details className="group rounded-xl bg-background/60 p-3 ring-1 ring-border/60 max-sm:p-2.5">
        <summary className="cursor-pointer text-[15px] font-semibold max-sm:text-sm">
          {t('easy.story_show_lyrics')}
        </summary>
        <pre
          data-slot="easy-story-result-lyrics"
          className="mt-2 font-sans text-[15px] leading-relaxed whitespace-pre-wrap text-muted-foreground max-sm:text-sm"
        >
          {job.lyrics}
        </pre>
      </details>

      <p className="text-sm text-muted-foreground">{t('easy.story_saved_history')}</p>
      <div className="flex flex-wrap gap-2 max-sm:grid max-sm:grid-cols-2">
        <Button variant="outline" className={buttonClass} onClick={() => void saveStoryLyrics(job)}>
          <FileTextIcon className="size-5" />
          {t('easy.story_save_lyrics')}
        </Button>
        <Button variant="ghost" data-slot="easy-story-new" className={buttonClass} onClick={onNew}>
          <RotateCcwIcon className="size-5" />
          {t('easy.cover_new')}
        </Button>
      </div>
    </section>
  );
}

function ErrorPanel({ title, message }: { title: string; message?: string | null }) {
  return (
    <div
      role="alert"
      data-slot="easy-story-error"
      className="flex items-start gap-3 rounded-2xl border border-destructive/40 bg-destructive/8 p-5 max-sm:p-3.5"
    >
      <CircleAlertIcon className="mt-0.5 size-6 shrink-0 text-destructive" />
      <div className="min-w-0">
        <p className="text-base font-semibold">{title}</p>
        {message && <p className="text-sm break-words text-muted-foreground">{message}</p>}
      </div>
    </div>
  );
}

export function EasyStorySongPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const profiles = useProfiles();
  const voices = easyVoices(profiles.data);
  const [draft, setDraftState] = useState<StoryDraft>(loadStoryDraft);
  const setDraft = (patch: Partial<StoryDraft>) =>
    setDraftState((old) => {
      const next = { ...old, ...patch };
      saveStoryDraft(next);
      return next;
    });

  const setup = useQuery({ queryKey: STORY_KEYS.setup, queryFn: storySongSetup });
  const jobs = useQuery({
    queryKey: STORY_KEYS.jobs,
    queryFn: listStorySongJobs,
    refetchInterval: (query) => (query.state.data?.jobs.some(isStoryActive) ? 1500 : false),
    refetchIntervalInBackground: false,
  });
  const job = currentStoryJob(jobs.data?.jobs, draft.dismissedJobId);
  const active = isStoryActive(job);

  const lyricsTask = useQuery({
    queryKey: STORY_KEYS.lyrics(draft.lyricsTaskId ?? ''),
    queryFn: () => getStoryLyrics(draft.lyricsTaskId!),
    enabled: Boolean(draft.lyricsTaskId),
    retry: false,
    refetchInterval: (query) => (isStoryActive(query.state.data) ? 1000 : false),
  });
  const writing =
    Boolean(draft.lyricsTaskId) && (lyricsTask.isLoading || isStoryActive(lyricsTask.data));
  const [lyricsError, setLyricsError] = useState<string | null>(null);

  // A finished lyrics task fills the editor once and the screen moves on to it.
  useEffect(() => {
    const task = lyricsTask.data;
    if (!draft.lyricsTaskId || !task || task.id !== draft.lyricsTaskId || isStoryActive(task))
      return;
    if (task.state === 'done' && task.result) {
      setLyricsError(null);
      setDraft({
        title: task.result.title,
        lyrics: task.result.lyrics,
        phase: 'lyrics',
        lyricsTaskId: null,
      });
    } else {
      const key = storyErrorKey(task);
      setLyricsError(
        task.state === 'cancelled'
          ? null
          : key
            ? t(key)
            : (task.error ?? t('easy.story_lyrics_failed')),
      );
      setDraft({ lyricsTaskId: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lyricsTask.data, draft.lyricsTaskId]);
  useEffect(() => {
    if (draft.lyricsTaskId && lyricsTask.isError) {
      setLyricsError(apiErrorText(lyricsTask.error, t));
      setDraft({ lyricsTaskId: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lyricsTask.isError, draft.lyricsTaskId]);

  // A finished song is a normal take: refresh the made-speech list once.
  const lastState = useRef<string | null>(null);
  useEffect(() => {
    const key = job ? `${job.id}:${job.state}` : null;
    if (job?.state === 'done' && lastState.current && lastState.current !== key)
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    lastState.current = key;
  }, [job, queryClient]);

  const voice = voices.find((item) => item.id === draft.voiceId) ?? voices[0] ?? null;
  const ready = Boolean(setup.data?.ready);

  const writeLyrics = useMutation({
    mutationFn: () =>
      startStoryLyrics({ story: draft.story.trim(), genre: draft.genre, length: draft.length }),
    onMutate: () => setLyricsError(null),
    onSuccess: (task) => setDraft({ lyricsTaskId: task.id }),
    onError: (error) => setLyricsError(apiErrorText(error, t)),
  });
  const stopLyrics = useMutation({
    mutationFn: (id: string) => cancelStoryLyrics(id),
    onSettled: () => setDraft({ lyricsTaskId: null }),
  });
  const makeSong = useMutation({
    mutationFn: () =>
      startStorySongJob({
        profileId: voice!.id,
        title: draft.title.trim(),
        lyrics: draft.lyrics,
        genre: draft.genre,
        length: draft.length,
      }),
    onSuccess: (created) => {
      queryClient.setQueryData(STORY_KEYS.jobs, (old: { jobs: StorySongJob[] } | undefined) => ({
        jobs: [created, ...(old?.jobs ?? []).filter((item) => item.id !== created.id)],
      }));
      void queryClient.invalidateQueries({ queryKey: STORY_KEYS.jobs });
    },
  });
  const cancelSong = useMutation({
    mutationFn: (id: string) => cancelStorySongJob(id),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: STORY_KEYS.jobs }),
  });

  const openRegister = () =>
    runRendererTask('Open voice registration', () => navigate({ to: EASY_ROUTES.newVoice }));

  const newSong = () => {
    makeSong.reset();
    setDraft({
      dismissedJobId: job?.id ?? draft.dismissedJobId,
      phase: 'story',
      title: '',
      lyrics: '',
    });
  };

  const storyLength = draft.story.trim().length;
  const canWrite = ready && storyLength >= STORY_MIN_CHARS && !writing && !writeLyrics.isPending;
  const lyricLines = storyLyricLines(draft.lyrics);
  const canMake = ready && lyricLines >= 2 && Boolean(voice) && !makeSong.isPending;

  const failedJob = job && (job.state === 'error' || job.state === 'cancelled') ? job : null;
  const showResult = job?.state === 'done' && !active;
  const busy = active || makeSong.isPending;
  const showEditor = !busy && !showResult;

  const genreLabel = (genre: StoryGenre) => t(`easy.story_genre_${genre}`);
  const lengthLabel = (length: StoryLength) => t(`easy.story_length_${length}`);

  return (
    <EasyPage title={t('easy.story_title')}>
      <div className="flex flex-col gap-5 max-sm:gap-3">
        <p
          data-slot="easy-story-notice"
          className="flex items-start gap-2 rounded-xl bg-muted/50 px-4 py-2.5 text-sm text-muted-foreground max-sm:px-3 max-sm:py-2 max-sm:text-[13px]"
        >
          <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" />
          <span>{t('easy.story_notice')}</span>
        </p>

        <SetupCard />

        {active && job && <SongProgress job={job} onCancel={() => cancelSong.mutate(job.id)} />}

        {makeSong.isPending && (
          <section
            role="status"
            aria-live="polite"
            className="flex items-center gap-3 rounded-2xl border border-primary/30 bg-primary/5 px-6 py-6 max-sm:px-3.5 max-sm:py-4"
          >
            <Spinner className="size-7 shrink-0 text-primary" aria-hidden="true" />
            <p className="text-base font-semibold">{t('easy.story_starting')}</p>
          </section>
        )}

        {showResult && job && <SongResult job={job} onNew={newSong} />}

        {!busy && !showResult && (failedJob || makeSong.error) && (
          <ErrorPanel
            title={
              failedJob?.state === 'cancelled' && !makeSong.error
                ? t('easy.cover_cancelled')
                : t('easy.cover_failed')
            }
            message={
              makeSong.error
                ? apiErrorText(makeSong.error, t)
                : failedJob?.state === 'error'
                  ? storyErrorKey(failedJob)
                    ? t(storyErrorKey(failedJob)!)
                    : failedJob.error
                  : null
            }
          />
        )}

        {showEditor && writing && (
          <section
            data-slot="easy-story-writing"
            role="status"
            aria-live="polite"
            className="flex flex-col gap-3 rounded-2xl border border-primary/30 bg-primary/5 px-6 py-6 max-sm:px-3.5 max-sm:py-4"
          >
            <div className="flex items-center gap-3">
              <Spinner className="size-7 shrink-0 text-primary" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-base font-semibold">{t('easy.story_writing')}</p>
                <p className="text-sm text-muted-foreground">{t('easy.story_writing_hint')}</p>
              </div>
            </div>
            <div>
              <Button
                variant="outline"
                className="h-11 rounded-xl px-5 text-[15px] max-sm:w-full"
                onClick={() => draft.lyricsTaskId && stopLyrics.mutate(draft.lyricsTaskId)}
              >
                {t('easy.cancel')}
              </Button>
            </div>
          </section>
        )}

        {showEditor && !writing && lyricsError && (
          <ErrorPanel title={t('easy.story_lyrics_failed')} message={lyricsError} />
        )}

        {showEditor && !writing && draft.phase === 'story' && (
          <>
            <EasySection
              step={1}
              title={t('easy.story_step_story')}
              hint={
                <span className="tabular-nums" data-slot="easy-story-count">
                  {t('easy.char_count', { n: draft.story.length, max: STORY_MAX_CHARS })}
                </span>
              }
            >
              <Textarea
                aria-label={t('easy.story_step_story')}
                data-slot="easy-story-text"
                value={draft.story}
                maxLength={STORY_MAX_CHARS}
                onChange={(event) => setDraft({ story: event.target.value })}
                placeholder={t('easy.story_placeholder')}
                className="max-h-96 min-h-40 rounded-xl px-4 py-3 text-base leading-relaxed md:text-base max-sm:max-h-72 max-sm:min-h-32 max-sm:px-3.5 max-sm:py-2.5 max-sm:text-[15px]"
              />
            </EasySection>

            <EasySection step={2} title={t('easy.story_step_mood')}>
              <ChoiceGroup
                label={t('easy.story_step_mood')}
                options={STORY_GENRES}
                value={draft.genre}
                onChange={(genre) => setDraft({ genre })}
                labelOf={genreLabel}
                columns="grid-cols-5 max-sm:grid-cols-3"
              />
            </EasySection>

            <EasySection step={3} title={t('easy.story_step_length')}>
              <ChoiceGroup
                label={t('easy.story_step_length')}
                options={STORY_LENGTHS}
                value={draft.length}
                onChange={(length) => setDraft({ length })}
                labelOf={lengthLabel}
                columns="grid-cols-3"
              />
            </EasySection>

            <EasySection step={4} title={t('easy.cover_step_voice')}>
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
                    <Button className="h-12 gap-2 rounded-xl px-5 text-base" onClick={openRegister}>
                      <PlusIcon className="size-5" />
                      {t('easy.register_voice')}
                    </Button>
                  }
                />
              ) : (
                <div
                  role="radiogroup"
                  aria-label={t('easy.cover_step_voice')}
                  className="grid gap-3 sm:grid-cols-2 max-sm:grid-cols-2 max-sm:gap-2"
                >
                  {voices.map((item) => (
                    <EasyVoiceTile
                      key={item.id}
                      name={item.name}
                      imageUrl={item.image_url}
                      subtitle={t('easy.my_voice')}
                      selected={item.id === voice?.id}
                      onSelect={() => setDraft({ voiceId: item.id })}
                      playKey={`voice:${item.id}`}
                      playSrc={profileAudioUrl(item.id, item.audio_url)}
                    />
                  ))}
                </div>
              )}
            </EasySection>

            <div className="flex flex-col items-stretch gap-2">
              <Button
                data-slot="easy-story-write"
                className="h-16 gap-3 rounded-2xl text-lg font-semibold max-sm:h-13 max-sm:gap-2 max-sm:text-[17px]"
                disabled={!canWrite}
                onClick={() => writeLyrics.mutate()}
              >
                <SparklesIcon className="size-6" />
                {t('easy.story_write_button')}
              </Button>
              {!canWrite && ready && storyLength < STORY_MIN_CHARS && (
                <p className="text-center text-sm text-muted-foreground">
                  {t('easy.story_need_story')}
                </p>
              )}
              {draft.lyrics && (
                <Button
                  variant="ghost"
                  className="h-11 gap-2 self-center rounded-xl px-4 text-[15px]"
                  onClick={() => setDraft({ phase: 'lyrics' })}
                >
                  <PenLineIcon className="size-5" />
                  {t('easy.story_back_to_lyrics')}
                </Button>
              )}
            </div>
          </>
        )}

        {showEditor && !writing && draft.phase === 'lyrics' && (
          <>
            <EasySection
              title={t('easy.story_step_lyrics')}
              hint={
                <span className="tabular-nums">
                  {t('easy.char_count', { n: draft.lyrics.length, max: STORY_MAX_LYRICS })}
                </span>
              }
            >
              <div className="flex flex-col gap-3 max-sm:gap-2">
                <Input
                  aria-label={t('easy.story_song_title')}
                  data-slot="easy-story-title"
                  value={draft.title}
                  maxLength={80}
                  placeholder={t('easy.story_song_title')}
                  onChange={(event) => setDraft({ title: event.target.value })}
                  className="h-12 rounded-xl px-4 text-base font-semibold md:text-base max-sm:h-11 max-sm:px-3.5 max-sm:text-[15px]"
                />
                <Textarea
                  aria-label={t('easy.story_step_lyrics')}
                  data-slot="easy-story-lyrics"
                  value={draft.lyrics}
                  maxLength={STORY_MAX_LYRICS}
                  onChange={(event) => setDraft({ lyrics: event.target.value })}
                  className="max-h-[32rem] min-h-72 rounded-xl px-4 py-3 text-base leading-relaxed md:text-base max-sm:max-h-[26rem] max-sm:min-h-60 max-sm:px-3.5 max-sm:py-2.5 max-sm:text-[15px]"
                />
                <p className="text-sm text-muted-foreground max-sm:text-[13px]">
                  {t('easy.story_lyrics_hint')}
                </p>
              </div>
            </EasySection>

            <p
              data-slot="easy-story-summary"
              className="rounded-xl bg-muted/50 px-4 py-2.5 text-[15px] text-muted-foreground max-sm:px-3 max-sm:py-2 max-sm:text-sm"
            >
              {t('easy.story_summary', {
                genre: genreLabel(draft.genre),
                length: lengthLabel(draft.length),
                voice: voice?.name ?? '',
              })}
            </p>

            <div className="flex flex-col items-stretch gap-2">
              <Button
                data-slot="easy-story-make"
                className="h-16 gap-3 rounded-2xl text-lg font-semibold max-sm:h-13 max-sm:gap-2 max-sm:text-[17px]"
                disabled={!canMake}
                onClick={() => {
                  if (job) setDraft({ dismissedJobId: job.id });
                  makeSong.mutate();
                }}
              >
                <Music2Icon className="size-6" />
                {t('easy.story_make_button')}
              </Button>
              {!canMake && ready && (
                <p className="text-center text-sm text-muted-foreground">
                  {lyricLines < 2
                    ? t('easy.story_need_lyrics')
                    : !voice
                      ? t('easy.cover_need_voice')
                      : null}
                </p>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  data-slot="easy-story-rewrite"
                  className="h-12 gap-2 rounded-xl px-3 text-base max-sm:h-11 max-sm:text-[15px]"
                  disabled={!canWrite}
                  onClick={() => writeLyrics.mutate()}
                >
                  <RotateCcwIcon className="size-5" />
                  {t('easy.story_rewrite')}
                </Button>
                <Button
                  variant="outline"
                  data-slot="easy-story-edit-story"
                  className="h-12 gap-2 rounded-xl px-3 text-base max-sm:h-11 max-sm:text-[15px]"
                  onClick={() => setDraft({ phase: 'story' })}
                >
                  <ArrowLeftIcon className="size-5" />
                  {t('easy.story_edit_story')}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </EasyPage>
  );
}
