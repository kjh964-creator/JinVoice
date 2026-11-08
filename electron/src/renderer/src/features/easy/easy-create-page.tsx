import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  AudioLinesIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  DownloadIcon,
  MicIcon,
  PlusIcon,
  RotateCcwIcon,
  SettingsIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ProfileAvatar } from '@/components/profile-avatar';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useEngines } from '@/hooks/use-engines';
import { useGenerateClone } from '@/hooks/use-generate';
import { useProfiles } from '@/hooks/use-profiles';
import { isPresetOnly } from '@/hooks/use-tts-readiness';
import { profileAudioUrl } from '@/lib/api/client';
import { EASY_ROUTES } from '@/lib/easy-mode';
import { runRendererTask } from '@/lib/global-error-recovery';
import {
  cloneSettingsStore,
  patchCloneSettings,
  setCloneSetting,
  useCloneSetting,
} from '@/lib/store/clone-settings';
import { useLatestOutput } from '@/lib/store/output';
import { cn } from '@/lib/utils';
import { easyDate, saveEasyBlob } from './easy-audio';
import { EasyEmpty, EasyPage, EasyPlayButton, EasySection } from './easy-layout';
import {
  EASY_MAX_CHARS,
  EASY_SPEEDS,
  easySpeedOf,
  easyVoices,
  type EasySpeed,
} from './easy-voices';

function VoiceTile({
  name,
  imageUrl,
  subtitle,
  selected,
  onSelect,
  playKey,
  playSrc,
}: {
  name: string;
  imageUrl?: string | null;
  subtitle?: string;
  selected: boolean;
  onSelect: () => void;
  playKey?: string;
  playSrc?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-h-18 items-center gap-2 rounded-2xl border bg-background p-2 ps-3 transition-colors',
        selected
          ? 'border-primary bg-primary/6 ring-2 ring-primary/25'
          : 'border-border hover:border-primary/40',
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={onSelect}
        className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-xl text-start outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <ProfileAvatar name={name} imageUrl={imageUrl} className="size-11 text-sm" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-base font-medium">{name}</span>
          {subtitle && <span className="truncate text-sm text-muted-foreground">{subtitle}</span>}
        </span>
        {selected && <CheckCircle2Icon className="ms-auto size-5 shrink-0 text-primary" />}
      </button>
      {playKey && playSrc && <EasyPlayButton playKey={playKey} src={playSrc} size="icon" />}
    </div>
  );
}

const SPEEDS: EasySpeed[] = ['slow', 'normal', 'fast'];

export function EasyCreatePage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const profiles = useProfiles();
  const voices = easyVoices(profiles.data);
  const dateFormat = new Intl.DateTimeFormat(i18n.language || undefined, { dateStyle: 'medium' });
  const { activeTts } = useEngines();
  const presetOnly = isPresetOnly(activeTts);
  const presets = presetOnly ? (activeTts?.preset_voices ?? []) : [];
  const text = useCloneSetting('text');
  const speed = useCloneSetting('speed');
  const selectedId = useCloneSetting('selectedProfileId');
  const presetVoice = useCloneSetting('presetVoice');
  const generation = useGenerateClone();
  const output = useLatestOutput();

  // Easy mode has no style, language or emotion controls: never let a value
  // left over from the full studio change how this take sounds.
  useEffect(() => {
    const settings = cloneSettingsStore.state;
    if (
      settings.language !== 'Auto' ||
      settings.instruct ||
      settings.emotionMode !== 'none' ||
      settings.duration
    )
      patchCloneSettings({ language: 'Auto', instruct: '', emotionMode: 'none', duration: '' });
  }, []);

  const selectedVoice = voices.find((voice) => voice.id === selectedId) ?? null;
  // Pick the newest voice once the list is in, so the first take is one click away.
  useEffect(() => {
    if (presetOnly || !profiles.data) return;
    if (!selectedVoice && voices[0]) setCloneSetting('selectedProfileId', voices[0].id);
  }, [presetOnly, profiles.data, selectedVoice, voices]);

  const hasVoice = presetOnly ? true : Boolean(selectedVoice);
  const hasText = text.trim().length > 0;
  const blocker = generation.cloneBlocker;
  const needsSetup = blocker === 'engine' || blocker === 'cloning';
  const ready = hasVoice && hasText && text.length <= EASY_MAX_CHARS && generation.canGenerate;
  // The last take stays on screen (also after visiting another page) until the next one starts.
  const showResult = Boolean(output.result) && !generation.isGenerating && !generation.error;
  const voiceName = presetOnly
    ? presetVoice || presets[0] || t('easy.builtin_voice')
    : (selectedVoice?.name ?? '');

  const start = () => void generation.generate();

  const openRegister = () =>
    runRendererTask('Open voice registration', () => navigate({ to: EASY_ROUTES.newVoice }));
  const openSettings = () =>
    runRendererTask('Open settings', () => navigate({ to: '/settings/models' }));

  return (
    <EasyPage title={t('easy.create_title')}>
      <div className="flex flex-col gap-5">
        {needsSetup && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-4 rounded-2xl border border-warning/40 bg-warning/10 p-5"
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

        <EasySection step={1} title={t('easy.step_voice')}>
          {presetOnly ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">{t('easy.builtin_only')}</p>
              <div
                role="radiogroup"
                aria-label={t('easy.step_voice')}
                className="grid gap-3 sm:grid-cols-2"
              >
                {presets.map((preset, index) => (
                  <VoiceTile
                    key={preset}
                    name={preset}
                    subtitle={t('easy.builtin_voice')}
                    selected={presetVoice ? presetVoice === preset : index === 0}
                    onSelect={() => setCloneSetting('presetVoice', preset)}
                  />
                ))}
              </div>
            </div>
          ) : profiles.isLoading ? (
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
              aria-label={t('easy.step_voice')}
              className="grid gap-3 sm:grid-cols-2"
            >
              {voices.map((voice) => (
                <VoiceTile
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
                  selected={voice.id === selectedId}
                  onSelect={() => setCloneSetting('selectedProfileId', voice.id)}
                  playKey={`voice:${voice.id}`}
                  playSrc={profileAudioUrl(voice.id, voice.audio_url)}
                />
              ))}
              <button
                type="button"
                onClick={openRegister}
                className="flex min-h-18 items-center justify-center gap-2 rounded-2xl border border-dashed border-border text-[15px] font-medium text-muted-foreground transition-colors outline-none hover:border-primary/50 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <PlusIcon className="size-5" />
                {t('easy.register_voice')}
              </button>
            </div>
          )}
        </EasySection>

        <EasySection
          step={2}
          title={t('easy.step_text')}
          hint={
            <span
              aria-live="polite"
              className={cn(text.length > EASY_MAX_CHARS && 'font-medium text-destructive')}
            >
              {t('easy.char_count', { n: text.length, max: EASY_MAX_CHARS })}
            </span>
          }
        >
          <Textarea
            aria-label={t('easy.step_text')}
            value={text}
            onChange={(event) => setCloneSetting('text', event.target.value)}
            placeholder={t('easy.text_placeholder')}
            className="min-h-36 rounded-xl px-4 py-3 text-base leading-relaxed md:text-base"
          />
        </EasySection>

        <EasySection step={3} title={t('easy.step_speed')}>
          <div
            role="radiogroup"
            aria-label={t('easy.step_speed')}
            className="grid grid-cols-3 gap-2 rounded-2xl bg-muted/60 p-1.5"
          >
            {SPEEDS.map((option) => {
              const active = easySpeedOf(speed) === option;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setCloneSetting('speed', EASY_SPEEDS[option])}
                  className={cn(
                    'h-12 rounded-xl text-base font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                    active
                      ? 'bg-background text-foreground shadow-sm ring-1 ring-border'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {t(`easy.speed_${option}`)}
                </button>
              );
            })}
          </div>
        </EasySection>

        {generation.isGenerating ? (
          <section
            role="status"
            aria-live="polite"
            className="flex flex-col items-center gap-4 rounded-2xl border border-primary/30 bg-primary/5 px-6 py-8 text-center"
          >
            <Spinner className="size-9 text-primary" aria-hidden="true" />
            <div>
              <p className="text-lg font-semibold">{t('easy.making')}</p>
              <p className="text-[15px] text-muted-foreground">
                {generation.stage === 'loading'
                  ? t('easy.making_first_time')
                  : t('easy.making_wait', { seconds: Math.floor(generation.elapsedSeconds) })}
              </p>
            </div>
            {generation.progress !== null && (
              <div className="h-2 w-full max-w-sm overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${generation.progress}%` }}
                />
              </div>
            )}
            <Button
              variant="outline"
              className="h-11 rounded-xl px-5 text-[15px]"
              onClick={generation.cancel}
            >
              {t('easy.cancel')}
            </Button>
          </section>
        ) : (
          <div className="flex flex-col items-stretch gap-2">
            <Button
              data-slot="easy-create-button"
              className="h-16 gap-3 rounded-2xl text-lg font-semibold"
              disabled={!ready}
              onClick={start}
            >
              <AudioLinesIcon className="size-6" />
              {t('easy.create_button')}
            </Button>
            {!ready && !needsSetup && (
              <p className="text-center text-sm text-muted-foreground">
                {!hasVoice
                  ? t('easy.need_voice')
                  : !hasText
                    ? t('easy.need_text')
                    : text.length > EASY_MAX_CHARS
                      ? t('easy.too_long', { max: EASY_MAX_CHARS })
                      : blocker === 'loading' || blocker === 'preparing'
                        ? t('easy.getting_ready')
                        : null}
              </p>
            )}
          </div>
        )}

        {generation.error && !generation.isGenerating && (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-2xl border border-destructive/40 bg-destructive/8 p-5"
          >
            <div className="flex items-start gap-3">
              <CircleAlertIcon className="mt-0.5 size-6 shrink-0 text-destructive" />
              <div className="min-w-0">
                <p className="text-base font-semibold">{t('easy.make_failed')}</p>
                <p className="text-sm break-words text-muted-foreground">{generation.error}</p>
              </div>
            </div>
            <div>
              <Button
                variant="outline"
                className="h-11 gap-2 rounded-xl px-4 text-[15px]"
                disabled={!ready}
                onClick={start}
              >
                <RotateCcwIcon className="size-4" />
                {t('easy.try_again')}
              </Button>
            </div>
          </div>
        )}

        {showResult && output.result && (
          <section
            data-slot="easy-result"
            aria-label={t('easy.result_title')}
            className="flex flex-col gap-4 rounded-2xl border border-success/40 bg-success/8 p-5 sm:p-6"
          >
            <div className="flex items-center gap-3">
              <CheckCircle2Icon className="size-7 shrink-0 text-success" />
              <div className="min-w-0">
                <p className="text-lg font-semibold">{t('easy.result_title')}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {output.result.durationSeconds
                    ? t('easy.result_meta', {
                        voice: voiceName,
                        seconds: Math.max(1, Math.round(output.result.durationSeconds)),
                      })
                    : voiceName}
                </p>
              </div>
            </div>
            <p className="line-clamp-3 rounded-xl bg-background/70 px-4 py-3 text-[15px] leading-relaxed">
              {output.text}
            </p>
            <div className="flex flex-wrap gap-2">
              <EasyPlayButton
                playKey={`take:${output.result.id ?? output.objectUrl}`}
                src={output.objectUrl}
                size="large"
              />
              <Button
                variant="outline"
                className="h-12 gap-2 rounded-xl px-5 text-base"
                onClick={() => output.result && void saveEasyBlob(output.result.blob)}
              >
                <DownloadIcon className="size-5" />
                {t('easy.save_file')}
              </Button>
              <Button
                variant="ghost"
                className="h-12 gap-2 rounded-xl px-5 text-base"
                disabled={!ready}
                onClick={start}
              >
                <RotateCcwIcon className="size-5" />
                {t('easy.make_again')}
              </Button>
            </div>
          </section>
        )}
      </div>
    </EasyPage>
  );
}
