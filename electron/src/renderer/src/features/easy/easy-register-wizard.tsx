import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CircleAlertIcon,
  FileAudioIcon,
  MicIcon,
  RotateCcwIcon,
  SquareIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useEngines } from '@/hooks/use-engines';
import { useRecording } from '@/hooks/use-recording';
import { ApiError, apiJson, describeError } from '@/lib/api/client';
import { REF_HARD_MAX_SECONDS } from '@/lib/api/generate';
import { createCloneProfile } from '@/lib/api/profiles';
import type { Profile } from '@/lib/api/types';
import { probeAudioDuration } from '@/lib/audio/probe';
import { createObjectUrl, revokeObjectUrl } from '@/lib/audio/object-url';
import { EASY_ROUTES } from '@/lib/easy-mode';
import { runRendererTask } from '@/lib/global-error-recovery';
import { queryKeys } from '@/lib/query';
import { engineTrimsReference } from '@/lib/reference-usage';
import { setCloneSetting } from '@/lib/store/clone-settings';
import { cn } from '@/lib/utils';
import { EasyPage, EasyPlayButton } from './easy-layout';

/** Recordings stop on their own here: 3–10 s is plenty and longer clips only slow things down. */
export const EASY_RECORD_LIMIT_SECONDS = 15;
const MIN_SECONDS = 2;

type Step = 1 | 2 | 3 | 4;
type Transcript = 'idle' | 'busy' | 'ready' | 'failed' | 'skipped';

function Stepper({ step }: { step: Step }) {
  const { t } = useTranslation();
  const labels = [
    t('easy.wizard_step_name'),
    t('easy.wizard_step_audio'),
    t('easy.wizard_step_text'),
    t('easy.wizard_step_save'),
  ];
  return (
    <ol
      className="mb-4 grid grid-cols-4 gap-2 max-sm:mb-3 max-sm:gap-1"
      aria-label={t('easy.wizard_progress')}
    >
      {labels.map((label, index) => {
        const number = (index + 1) as Step;
        const done = number < step;
        const active = number === step;
        return (
          <li
            key={label}
            aria-current={active ? 'step' : undefined}
            className="flex flex-col items-center gap-1.5 text-center max-sm:gap-1"
          >
            <span
              className={cn(
                'flex size-9 items-center justify-center rounded-full text-sm font-semibold transition-colors max-sm:size-8',
                done && 'bg-primary text-primary-foreground',
                active && 'bg-primary text-primary-foreground ring-4 ring-primary/20',
                !done && !active && 'bg-muted text-muted-foreground',
              )}
            >
              {done ? <CheckIcon className="size-4" /> : number}
            </span>
            <span
              className={cn(
                'text-sm leading-tight max-sm:text-[12.5px]',
                active ? 'font-semibold text-foreground' : 'text-muted-foreground',
              )}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function CheckRow({
  checked,
  onChange,
  children,
  testId,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition-colors max-sm:p-3.5',
        checked ? 'border-primary bg-primary/6' : 'border-border hover:border-primary/40',
      )}
    >
      <input
        type="checkbox"
        data-testid={testId}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]"
      />
      <span className="text-base leading-snug max-sm:text-[15px]">{children}</span>
    </label>
  );
}

export function EasyRegisterWizard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { activeTts } = useEngines();
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [source, setSource] = useState<'mic' | 'file'>('mic');
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [transcript, setTranscript] = useState('');
  const [transcriptState, setTranscriptState] = useState<Transcript>('idle');
  const [transcriptOk, setTranscriptOk] = useState(false);
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const transcribedFor = useRef<File | null>(null);

  const accept = async (picked: File) => {
    setAudioError(null);
    const seconds = await probeAudioDuration(picked);
    if (seconds !== null && seconds > REF_HARD_MAX_SECONDS) {
      setAudioError(t('easy.audio_too_long', { max: REF_HARD_MAX_SECONDS }));
      return;
    }
    if (seconds !== null && seconds < MIN_SECONDS) {
      setAudioError(t('easy.audio_too_short'));
      return;
    }
    setFile(picked);
    setDuration(seconds);
    setTranscriptOk(false);
  };

  const recording = useRecording((recorded) => void accept(recorded), false);
  const recordingBusy = recording.isRecording || recording.isStarting || recording.isCleaning;

  useEffect(() => {
    if (recording.isRecording && recording.seconds >= EASY_RECORD_LIMIT_SECONDS) recording.stop();
  }, [recording, recording.isRecording, recording.seconds]);

  useEffect(() => {
    const url = file ? createObjectUrl(file) : null;
    setPreview(url);
    return () => revokeObjectUrl(url);
  }, [file]);

  const skipTranscript = engineTrimsReference(activeTts, duration);

  // Ask the computer what was said once per clip; the user then checks and fixes it.
  useEffect(() => {
    if (step !== 3 || !file || transcribedFor.current === file) return;
    transcribedFor.current = file;
    if (skipTranscript) {
      setTranscript('');
      setTranscriptState('skipped');
      return;
    }
    const controller = new AbortController();
    let settled = false;
    setTranscriptState('busy');
    void (async () => {
      try {
        const body = new FormData();
        body.set('audio', file);
        body.set('mode', 'reference');
        body.set('refine', 'false');
        const result = await apiJson<{ text: string }>('/transcribe', {
          method: 'POST',
          body,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setTranscript(result.text.trim());
        setTranscriptOk(false);
        setTranscriptState(result.text.trim() ? 'ready' : 'failed');
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!(error instanceof ApiError)) console.warn('Transcription failed', error);
        setTranscriptState('failed');
      } finally {
        settled = true;
      }
    })();
    return () => {
      // Leaving mid-request asks again next time; a finished answer (and the
      // user's edits to it) is kept.
      if (settled) return;
      controller.abort();
      if (transcribedFor.current === file) transcribedFor.current = null;
    };
  }, [step, file, skipTranscript]);

  const transcriptConfirmed =
    transcriptState === 'skipped' || (transcriptOk && transcript.trim().length > 0);
  const canSave = Boolean(name.trim() && file && transcriptConfirmed && consent && !saving);

  const save = async () => {
    if (!file || !canSave) return;
    setSaving(true);
    try {
      const created = await createCloneProfile({
        name: name.trim(),
        refAudio: file,
        refAudioName: file.name,
        refText: transcriptState === 'skipped' ? '' : transcript.trim(),
        language: 'Auto',
      });
      client.setQueryData<Profile[]>(queryKeys.profiles, (old) => [
        created,
        ...(old ?? []).filter((profile) => profile.id !== created.id),
      ]);
      void client.invalidateQueries({ queryKey: queryKeys.profiles });
      setCloneSetting('selectedProfileId', created.id);
      toast.success(t('easy.voice_saved', { name: created.name }));
      runRendererTask('Back to my voices', () => navigate({ to: EASY_ROUTES.voices }));
    } catch (error) {
      toast.error(t('easy.voice_save_failed', { message: describeError(error) }));
    } finally {
      setSaving(false);
    }
  };

  const resetAudio = () => {
    setFile(null);
    setDuration(null);
    setAudioError(null);
    setTranscript('');
    setTranscriptState('idle');
    setTranscriptOk(false);
    transcribedFor.current = null;
  };

  const next = (
    <Button
      className="h-12 gap-2 rounded-xl px-6 text-base max-sm:h-11 max-sm:px-5 max-sm:text-[15px]"
      disabled={
        (step === 1 && !name.trim()) ||
        (step === 2 && (!file || recordingBusy)) ||
        (step === 3 && !transcriptConfirmed)
      }
      onClick={() => setStep((current) => Math.min(4, current + 1) as Step)}
    >
      {t('easy.next')}
      <ArrowRightIcon className="size-5" />
    </Button>
  );
  const back =
    step > 1 ? (
      <Button
        variant="ghost"
        className="h-12 gap-2 rounded-xl px-4 text-base max-sm:h-11 max-sm:px-3 max-sm:text-[15px]"
        disabled={recordingBusy || saving}
        onClick={() => setStep((current) => Math.max(1, current - 1) as Step)}
      >
        <ArrowLeftIcon className="size-5" />
        {t('easy.previous')}
      </Button>
    ) : (
      <span />
    );

  return (
    <EasyPage
      title={t('easy.wizard_title')}
      backTo={EASY_ROUTES.voices}
      backLabel={t('easy.voices_title')}
    >
      <div className="mx-auto w-full max-w-3xl">
        <Stepper step={step} />
        <section className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card p-5 shadow-xs max-sm:gap-3.5 max-sm:p-4">
          {step === 1 && (
            <>
              <div>
                <h2 className="text-xl font-semibold max-sm:text-lg max-sm:leading-snug">
                  {t('easy.name_question')}
                </h2>
                <p className="mt-1 text-[15px] text-muted-foreground max-sm:mt-0.5 max-sm:text-sm">
                  {t('easy.name_hint')}
                </p>
              </div>
              <Input
                autoFocus
                aria-label={t('easy.voice_name')}
                value={name}
                maxLength={60}
                placeholder={t('easy.name_placeholder')}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && name.trim()) setStep(2);
                }}
                className="h-14 rounded-xl px-4 text-lg md:text-lg max-sm:h-12 max-sm:text-[17px]"
              />
            </>
          )}

          {step === 2 && (
            <>
              <div>
                <h2 className="text-xl font-semibold max-sm:text-lg max-sm:leading-snug">
                  {t('easy.audio_question')}
                </h2>
                <p className="mt-1 text-[15px] text-muted-foreground max-sm:mt-0.5 max-sm:text-sm">
                  {t('easy.audio_hint')}
                </p>
              </div>
              <div
                role="tablist"
                aria-label={t('easy.wizard_step_audio')}
                className="grid grid-cols-2 gap-2 rounded-2xl bg-muted/60 p-1.5 max-sm:gap-1 max-sm:p-1"
              >
                {(['mic', 'file'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="tab"
                    aria-selected={source === option}
                    disabled={recordingBusy}
                    onClick={() => setSource(option)}
                    className={cn(
                      'flex h-12 items-center justify-center gap-2 rounded-xl text-base font-medium max-sm:h-10 max-sm:text-[15px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60',
                      source === option
                        ? 'bg-background text-foreground shadow-sm ring-1 ring-border'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {option === 'mic' ? (
                      <MicIcon className="size-5" />
                    ) : (
                      <FileAudioIcon className="size-5" />
                    )}
                    {t(option === 'mic' ? 'easy.source_mic' : 'easy.source_file')}
                  </button>
                ))}
              </div>

              {file ? (
                <div className="flex flex-col gap-3 rounded-2xl border border-success/40 bg-success/8 p-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    <CheckIcon className="size-6 shrink-0 text-success" />
                    <div className="min-w-0">
                      <p className="text-base font-semibold">{t('easy.audio_ready')}</p>
                      <p className="truncate text-sm text-muted-foreground">
                        {duration !== null
                          ? t('easy.audio_length', { seconds: Math.round(duration) })
                          : file.name}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <EasyPlayButton
                      playKey="wizard:preview"
                      src={preview}
                      label={t('easy.listen')}
                    />
                    <Button
                      variant="ghost"
                      className="h-11 gap-2 rounded-xl px-4 text-[15px]"
                      onClick={resetAudio}
                    >
                      <RotateCcwIcon className="size-4" />
                      {t(source === 'mic' ? 'easy.record_again' : 'easy.pick_again')}
                    </Button>
                  </div>
                </div>
              ) : source === 'mic' ? (
                <div className="flex flex-col items-center gap-4 sm:grid sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-5 max-sm:gap-3.5">
                  <div className="w-full rounded-2xl bg-muted/50 p-4 sm:col-span-2">
                    <p className="text-sm font-medium text-muted-foreground">
                      {t('easy.read_this')}
                    </p>
                    <p className="mt-2 text-xl leading-relaxed font-medium max-sm:mt-1 max-sm:text-lg">
                      {t('easy.example_sentence')}
                    </p>
                  </div>
                  <Button
                    aria-label={t(
                      recording.isRecording ? 'easy.stop_recording' : 'easy.start_recording',
                    )}
                    className={cn(
                      'size-24 rounded-full shadow-md max-sm:size-20',
                      recording.isRecording &&
                        'border-destructive bg-destructive text-white hover:bg-destructive/90',
                    )}
                    disabled={recording.isStarting || recording.isCleaning}
                    onClick={() =>
                      recording.isRecording ? recording.stop() : void recording.start()
                    }
                  >
                    {recording.isRecording ? (
                      <SquareIcon className="size-8 fill-current" />
                    ) : (
                      <MicIcon className="size-10" />
                    )}
                  </Button>
                  <div
                    className="flex min-w-0 flex-col items-center gap-2 sm:items-start"
                    aria-live="polite"
                  >
                    <span
                      className={cn(
                        'font-mono text-3xl tabular-nums max-sm:text-2xl',
                        recording.isRecording ? 'text-destructive' : 'text-muted-foreground',
                      )}
                    >
                      {formatClock(recording.isRecording ? recording.seconds : 0)}
                    </span>
                    {recording.isRecording && (
                      <div className="h-2 w-48 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-destructive transition-[width] duration-75"
                          style={{ width: `${Math.min(100, Math.round(recording.level * 160))}%` }}
                        />
                      </div>
                    )}
                    <span className="text-center text-[15px] text-muted-foreground sm:text-start max-sm:text-sm">
                      {recording.isCleaning
                        ? t('easy.recording_cleaning')
                        : recording.isRecording
                          ? recording.seconds >= 3
                            ? t('easy.recording_enough')
                            : t('easy.recording_now')
                          : t('easy.recording_tip')}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-6 py-6 text-center max-sm:px-4">
                  <FileAudioIcon className="size-10 text-primary" />
                  <p className="text-[15px] text-muted-foreground">{t('easy.file_hint')}</p>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.webm,.aac"
                    className="hidden"
                    data-testid="easy-audio-file"
                    onChange={(event) => {
                      const picked = event.target.files?.[0];
                      event.target.value = '';
                      if (picked) void accept(picked);
                    }}
                  />
                  <Button
                    className="h-12 gap-2 rounded-xl px-5 text-base"
                    onClick={() => fileInput.current?.click()}
                  >
                    <FileAudioIcon className="size-5" />
                    {t('easy.pick_file')}
                  </Button>
                </div>
              )}
              {audioError && (
                <p role="alert" className="flex items-center gap-2 text-[15px] text-destructive">
                  <CircleAlertIcon className="size-5 shrink-0" />
                  {audioError}
                </p>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <div>
                <h2 className="text-xl font-semibold max-sm:text-lg max-sm:leading-snug">
                  {t('easy.text_question')}
                </h2>
                <p className="mt-1 text-[15px] text-muted-foreground max-sm:mt-0.5 max-sm:text-sm">
                  {t('easy.text_hint')}
                </p>
              </div>
              {transcriptState === 'busy' ? (
                <div role="status" className="flex items-center gap-3 rounded-2xl bg-muted/50 p-5">
                  <Spinner className="size-6 text-primary" aria-hidden="true" />
                  <span className="text-base">{t('easy.listening')}</span>
                </div>
              ) : transcriptState === 'skipped' ? (
                <div className="rounded-2xl bg-muted/50 p-5 text-[15px] text-muted-foreground">
                  {t('easy.text_skipped')}
                </div>
              ) : (
                <>
                  {transcriptState === 'failed' && (
                    <p className="flex items-center gap-2 text-[15px] text-muted-foreground">
                      <CircleAlertIcon className="size-5 shrink-0 text-warning" />
                      {t('easy.text_failed')}
                    </p>
                  )}
                  <Textarea
                    aria-label={t('easy.text_question')}
                    value={transcript}
                    placeholder={t('easy.text_placeholder_heard')}
                    onChange={(event) => {
                      setTranscript(event.target.value);
                    }}
                    className="min-h-28 rounded-xl px-4 py-3 text-lg leading-relaxed md:text-lg max-sm:min-h-24 max-sm:px-3.5 max-sm:py-2.5 max-sm:text-base"
                  />
                  <div className="flex flex-wrap gap-2">
                    <EasyPlayButton
                      playKey="wizard:preview"
                      src={preview}
                      label={t('easy.listen')}
                    />
                  </div>
                  <CheckRow
                    checked={transcriptOk}
                    onChange={setTranscriptOk}
                    testId="easy-transcript-confirm"
                  >
                    {t('easy.text_confirm')}
                  </CheckRow>
                </>
              )}
            </>
          )}

          {step === 4 && (
            <>
              <div>
                <h2 className="text-xl font-semibold max-sm:text-lg max-sm:leading-snug">
                  {t('easy.save_question')}
                </h2>
                <p className="mt-1 text-[15px] text-muted-foreground max-sm:mt-0.5 max-sm:text-sm">
                  {t('easy.save_hint')}
                </p>
              </div>
              <dl className="grid gap-2 rounded-2xl bg-muted/50 p-4 text-[15px] sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-4 max-sm:gap-1">
                <dt className="text-muted-foreground">{t('easy.voice_name')}</dt>
                <dd className="font-medium">{name.trim()}</dd>
                <dt className="text-muted-foreground">{t('easy.wizard_step_audio')}</dt>
                <dd className="font-medium">
                  {duration !== null
                    ? t('easy.audio_length', { seconds: Math.round(duration) })
                    : file?.name}
                </dd>
                {transcriptState !== 'skipped' && (
                  <>
                    <dt className="text-muted-foreground">{t('easy.wizard_step_text')}</dt>
                    <dd className="font-medium break-words">{transcript.trim()}</dd>
                  </>
                )}
              </dl>
              <CheckRow checked={consent} onChange={setConsent} testId="easy-consent">
                {t('easy.consent')}
              </CheckRow>
            </>
          )}

          <div className="mt-1 flex items-center justify-between gap-3 border-t border-border/60 pt-4 max-sm:pt-3.5">
            {back}
            {step < 4 ? (
              next
            ) : (
              <Button
                className="h-12 gap-2 rounded-xl px-6 text-base max-sm:h-11 max-sm:px-5 max-sm:text-[15px]"
                disabled={!canSave}
                onClick={() => void save()}
              >
                {saving ? (
                  <Spinner className="size-5" aria-hidden="true" />
                ) : (
                  <CheckIcon className="size-5" />
                )}
                {t('easy.save_voice')}
              </Button>
            )}
          </div>
        </section>
      </div>
    </EasyPage>
  );
}
