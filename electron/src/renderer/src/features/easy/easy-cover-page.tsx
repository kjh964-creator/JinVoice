import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleIcon,
  DownloadIcon,
  FileAudioIcon,
  MicIcon,
  MinusIcon,
  Music2Icon,
  PlusIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useProfiles } from '@/hooks/use-profiles';
import { audioUrl, describeError, profileAudioUrl } from '@/lib/api/client';
import { EASY_ROUTES } from '@/lib/easy-mode';
import { runRendererTask } from '@/lib/global-error-recovery';
import { queryKeys } from '@/lib/query';
import { cn } from '@/lib/utils';
import { saveEasyAudioFile } from './easy-audio';
import {
  COVER_ACCEPT,
  COVER_MAX_BYTES,
  COVER_PITCH_RANGE,
  COVER_STEPS,
  cancelCoverJob,
  cancelCoverSetup,
  coverClock,
  coverErrorKey,
  coverFileName,
  coverMegabytes,
  coverPitchLabel,
  coverSetup,
  currentCoverJob,
  dismissCoverJob,
  isCoverActive,
  listCoverJobs,
  saveCoverInstrumental,
  startCoverJob,
  startCoverSetup,
  useDismissedCoverJob,
  type CoverJob,
} from './easy-cover';
import { EasyEmpty, EasyPage, EasyPlayButton, EasySection } from './easy-layout';
import { EasyVoiceTile } from './easy-voice-tile';
import { easyVoices } from './easy-voices';

const COVER_KEYS = {
  setup: ['cover', 'setup'] as const,
  jobs: ['cover', 'jobs'] as const,
};

function CoverSetupCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const setup = useQuery({
    queryKey: COVER_KEYS.setup,
    queryFn: coverSetup,
    refetchInterval: (query) => (query.state.data?.install.state === 'running' ? 1000 : false),
  });
  const start = useMutation({
    mutationFn: startCoverSetup,
    onSuccess: (data) => queryClient.setQueryData(COVER_KEYS.setup, data),
  });
  const cancel = useMutation({
    mutationFn: cancelCoverSetup,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: COVER_KEYS.setup }),
  });
  const data = setup.data;
  if (!data || data.ready) return null;
  const running = data.install.state === 'running';
  return (
    <section
      data-slot="easy-cover-setup"
      role="status"
      className="flex flex-col gap-4 rounded-2xl border border-primary/30 bg-primary/5 p-5 max-sm:gap-3 max-sm:p-3.5"
    >
      <div className="flex items-start gap-3">
        <DownloadIcon className="mt-0.5 size-6 shrink-0 text-primary max-sm:size-5" />
        <div className="min-w-0">
          <p className="text-base font-semibold">{t('easy.cover_setup_title')}</p>
          <p className="text-[15px] text-muted-foreground max-sm:text-sm">
            {t('easy.cover_setup_body', {
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
            data-slot="easy-cover-setup-button"
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

function CoverProgress({ job, onCancel }: { job: CoverJob; onCancel: () => void }) {
  const { t } = useTranslation();
  const current = COVER_STEPS.indexOf(job.step);
  return (
    <section
      data-slot="easy-cover-progress"
      role="status"
      aria-live="polite"
      className="flex flex-col gap-4 rounded-2xl border border-primary/30 bg-primary/5 px-6 py-6 max-sm:gap-3 max-sm:px-3.5 max-sm:py-4"
    >
      <div className="flex items-center gap-3">
        <Spinner className="size-8 shrink-0 text-primary max-sm:size-7" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-lg font-semibold max-sm:text-[17px]">{t('easy.cover_making')}</p>
          <p className="truncate text-sm text-muted-foreground">
            {job.profile_name} · {job.song_name}
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
        {COVER_STEPS.map((step, index) => {
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
              <span className="min-w-0 flex-1">{t(`easy.cover_step_${step}`)}</span>
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

function CoverResultPanel({ job, onNew }: { job: CoverJob; onNew: () => void }) {
  const { t } = useTranslation();
  const result = job.result;
  if (!result) return null;
  return (
    <section
      data-slot="easy-cover-result"
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
              song: job.song_name,
              time: coverClock(result.duration_s),
            })}
          </p>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        {t('easy.cover_pitch_applied', { value: coverPitchLabel(result.semitones) })}
        {' · '}
        {t('easy.cover_saved_history')}
      </p>
      <div className="flex flex-wrap gap-2 max-sm:grid max-sm:grid-cols-2">
        <EasyPlayButton
          playKey={`cover:${result.id}`}
          src={audioUrl(result.audio_path)}
          size="large"
        />
        <Button
          variant="outline"
          className="h-12 gap-2 rounded-xl px-5 text-base max-sm:h-11 max-sm:px-3 max-sm:text-[15px]"
          onClick={() => void saveEasyAudioFile(result.audio_path, coverFileName(job))}
        >
          <DownloadIcon className="size-5" />
          {t('easy.save_file')}
        </Button>
        {result.has_instrumental && (
          <Button
            variant="outline"
            className="h-12 gap-2 rounded-xl px-5 text-base max-sm:h-11 max-sm:px-3 max-sm:text-[15px]"
            onClick={() => void saveCoverInstrumental(job)}
          >
            <Music2Icon className="size-5" />
            {t('easy.cover_save_instrumental')}
          </Button>
        )}
        <Button
          variant="ghost"
          data-slot="easy-cover-new"
          className="h-12 gap-2 rounded-xl px-5 text-base max-sm:h-11 max-sm:text-[15px]"
          onClick={onNew}
        >
          <RotateCcwIcon className="size-5" />
          {t('easy.cover_new')}
        </Button>
      </div>
    </section>
  );
}

function PitchPicker({
  value,
  onChange,
}: {
  value: number | 'auto';
  onChange: (value: number | 'auto') => void;
}) {
  const { t } = useTranslation();
  const auto = value === 'auto';
  const number = auto ? 0 : value;
  const step = (delta: number) =>
    onChange(Math.max(-COVER_PITCH_RANGE, Math.min(COVER_PITCH_RANGE, number + delta)));
  return (
    <div className="flex flex-col gap-3 max-sm:gap-2">
      <div
        role="radiogroup"
        aria-label={t('easy.cover_step_pitch')}
        className="grid grid-cols-2 gap-2 rounded-2xl bg-muted/60 p-1.5 max-sm:gap-1 max-sm:p-1"
      >
        {(['auto', 'manual'] as const).map((mode) => {
          const active = mode === 'auto' ? auto : !auto;
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(mode === 'auto' ? 'auto' : number)}
              className={cn(
                'h-12 rounded-xl text-base font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 max-sm:h-10 max-sm:text-[15px]',
                active
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-border'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(mode === 'auto' ? 'easy.cover_pitch_auto' : 'easy.cover_pitch_manual')}
            </button>
          );
        })}
      </div>
      {auto ? (
        <p className="text-sm text-muted-foreground">{t('easy.cover_pitch_auto_hint')}</p>
      ) : (
        <div className="flex items-center gap-3 max-sm:gap-2">
          <Button
            variant="outline"
            className="size-12 rounded-xl max-sm:size-11"
            aria-label={t('easy.cover_pitch_down')}
            title={t('easy.cover_pitch_down')}
            disabled={number <= -COVER_PITCH_RANGE}
            onClick={() => step(-1)}
          >
            <MinusIcon className="size-5" />
          </Button>
          <output
            data-slot="easy-cover-pitch-value"
            aria-live="polite"
            className="min-w-14 text-center text-2xl font-semibold tabular-nums max-sm:text-xl"
          >
            {coverPitchLabel(number)}
          </output>
          <Button
            variant="outline"
            className="size-12 rounded-xl max-sm:size-11"
            aria-label={t('easy.cover_pitch_up')}
            title={t('easy.cover_pitch_up')}
            disabled={number >= COVER_PITCH_RANGE}
            onClick={() => step(1)}
          >
            <PlusIcon className="size-5" />
          </Button>
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            {t('easy.cover_pitch_manual_hint')}
          </p>
        </div>
      )}
    </div>
  );
}

export function EasyCoverPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const profiles = useProfiles();
  const voices = easyVoices(profiles.data);
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [semitones, setSemitones] = useState<number | 'auto'>('auto');
  const dismissed = useDismissedCoverJob();

  const setup = useQuery({ queryKey: COVER_KEYS.setup, queryFn: coverSetup });
  const jobs = useQuery({
    queryKey: COVER_KEYS.jobs,
    queryFn: listCoverJobs,
    refetchInterval: (query) => (query.state.data?.jobs.some(isCoverActive) ? 1500 : false),
    refetchIntervalInBackground: false,
  });
  const job = currentCoverJob(jobs.data?.jobs, dismissed);
  const active = isCoverActive(job);

  // A finished cover is a normal take: refresh the made-speech list once.
  const lastState = useRef<string | null>(null);
  useEffect(() => {
    const key = job ? `${job.id}:${job.state}` : null;
    if (job?.state === 'done' && lastState.current && lastState.current !== key)
      void queryClient.invalidateQueries({ queryKey: queryKeys.history });
    lastState.current = key;
  }, [job, queryClient]);

  const voice = voices.find((item) => item.id === voiceId) ?? voices[0] ?? null;

  const start = useMutation({
    mutationFn: () => startCoverJob({ file: file!, profileId: voice!.id, semitones }),
    onSuccess: (created) => {
      queryClient.setQueryData(COVER_KEYS.jobs, (old: { jobs: CoverJob[] } | undefined) => ({
        jobs: [created, ...(old?.jobs ?? []).filter((item) => item.id !== created.id)],
      }));
      void queryClient.invalidateQueries({ queryKey: COVER_KEYS.jobs });
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) => cancelCoverJob(id),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: COVER_KEYS.jobs }),
  });

  const ready = Boolean(setup.data?.ready);
  const canStart = ready && Boolean(file) && Boolean(voice) && !start.isPending;

  const pickFile = (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size > COVER_MAX_BYTES) {
      setFile(null);
      setFileError(t('easy.cover_err_too_large'));
      return;
    }
    setFileError(null);
    setFile(picked);
  };

  const openRegister = () =>
    runRendererTask('Open voice registration', () => navigate({ to: EASY_ROUTES.newVoice }));

  const newSong = () => {
    if (job) dismissCoverJob(job.id);
    start.reset();
  };

  const errorText = (failed: CoverJob) => {
    const key = coverErrorKey(failed);
    return key ? t(key) : (failed.error ?? '');
  };

  const showForm = !active && !start.isPending && (!job || job.state !== 'done');
  const failedJob = job && (job.state === 'error' || job.state === 'cancelled') ? job : null;

  return (
    <EasyPage title={t('easy.cover_title')}>
      <div className="flex flex-col gap-5 max-sm:gap-3">
        <p
          data-slot="easy-cover-notice"
          className="flex items-start gap-2 rounded-xl bg-muted/50 px-4 py-2.5 text-sm text-muted-foreground max-sm:px-3 max-sm:py-2 max-sm:text-[13px]"
        >
          <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" />
          <span>{t('easy.cover_notice')}</span>
        </p>

        <CoverSetupCard />

        {active && job && <CoverProgress job={job} onCancel={() => cancel.mutate(job.id)} />}

        {start.isPending && (
          <section
            role="status"
            aria-live="polite"
            className="flex items-center gap-3 rounded-2xl border border-primary/30 bg-primary/5 px-6 py-6 max-sm:px-3.5 max-sm:py-4"
          >
            <Spinner className="size-7 shrink-0 text-primary" aria-hidden="true" />
            <p className="text-base font-semibold">{t('easy.cover_uploading')}</p>
          </section>
        )}

        {job?.state === 'done' && !active && <CoverResultPanel job={job} onNew={newSong} />}

        {(failedJob || start.error) && !active && !start.isPending && (
          <div
            role="alert"
            data-slot="easy-cover-error"
            className="flex flex-col gap-3 rounded-2xl border border-destructive/40 bg-destructive/8 p-5 max-sm:p-3.5"
          >
            <div className="flex items-start gap-3">
              <CircleAlertIcon className="mt-0.5 size-6 shrink-0 text-destructive" />
              <div className="min-w-0">
                <p className="text-base font-semibold">
                  {failedJob?.state === 'cancelled' && !start.error
                    ? t('easy.cover_cancelled')
                    : t('easy.cover_failed')}
                </p>
                {(start.error || failedJob?.state === 'error') && (
                  <p className="text-sm break-words text-muted-foreground">
                    {start.error ? describeError(start.error) : errorText(failedJob!)}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {showForm && (
          <>
            <EasySection step={1} title={t('easy.cover_step_song')}>
              <input
                ref={fileInput}
                type="file"
                accept={COVER_ACCEPT}
                className="sr-only"
                aria-label={t('easy.cover_pick_song')}
                data-slot="easy-cover-file"
                onChange={(event) => {
                  pickFile(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
              {file ? (
                <div className="flex items-center gap-3 rounded-2xl border border-primary bg-primary/6 p-3 ring-2 ring-primary/25 max-sm:gap-2 max-sm:p-2.5">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary max-sm:size-9">
                    <FileAudioIcon className="size-6 max-sm:size-5" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      data-slot="easy-cover-file-name"
                      className="truncate text-base font-medium max-sm:text-[15px]"
                    >
                      {file.name}
                    </span>
                    <span className="text-sm text-muted-foreground max-sm:text-[13px]">
                      {coverMegabytes(file.size)}
                    </span>
                  </span>
                  <Button
                    variant="outline"
                    className="h-11 shrink-0 rounded-xl px-4 text-[15px] max-sm:h-10 max-sm:px-3 max-sm:text-sm"
                    onClick={() => fileInput.current?.click()}
                  >
                    {t('easy.cover_change_song')}
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  data-slot="easy-cover-pick"
                  onClick={() => fileInput.current?.click()}
                  className="flex min-h-24 w-full flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-border px-4 py-5 text-center transition-colors outline-none hover:border-primary/50 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/40 max-sm:min-h-0 max-sm:flex-row max-sm:gap-2.5 max-sm:py-3.5"
                >
                  <Music2Icon className="size-7 text-primary max-sm:size-5" />
                  <span className="text-base font-medium max-sm:text-[15px]">
                    {t('easy.cover_pick_song')}
                  </span>
                  <span className="text-sm text-muted-foreground max-sm:hidden">
                    {t('easy.cover_song_hint')}
                  </span>
                </button>
              )}
              {fileError && <p className="mt-2 text-sm text-destructive">{fileError}</p>}
            </EasySection>

            <EasySection step={2} title={t('easy.cover_step_voice')}>
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
                      onSelect={() => setVoiceId(item.id)}
                      playKey={`voice:${item.id}`}
                      playSrc={profileAudioUrl(item.id, item.audio_url)}
                    />
                  ))}
                </div>
              )}
            </EasySection>

            <EasySection step={3} title={t('easy.cover_step_pitch')}>
              <PitchPicker value={semitones} onChange={setSemitones} />
            </EasySection>

            <div className="flex flex-col items-stretch gap-2">
              <Button
                data-slot="easy-cover-button"
                className="h-16 gap-3 rounded-2xl text-lg font-semibold max-sm:h-13 max-sm:gap-2 max-sm:text-[17px]"
                disabled={!canStart}
                onClick={() => {
                  if (job) dismissCoverJob(job.id);
                  start.mutate();
                }}
              >
                <Music2Icon className="size-6" />
                {t('easy.cover_button')}
              </Button>
              {!canStart && ready && (
                <p className="text-center text-sm text-muted-foreground">
                  {!file ? t('easy.cover_need_song') : !voice ? t('easy.cover_need_voice') : null}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </EasyPage>
  );
}
