import { CheckCircle2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ProfileAvatar } from '@/components/profile-avatar';
import { cn } from '@/lib/utils';
import { EasyPlayButton } from './easy-layout';
import { EASY_SPEEDS, easySpeedOf, type EasySpeed } from './easy-voices';

/** One choosable voice: avatar, name, a line under it, and a listen button. */
export function EasyVoiceTile({
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

/** Slow / normal / fast, as one segmented control. */
export function EasySpeedPicker({
  speed,
  onChange,
}: {
  speed: number;
  onChange: (speed: number) => void;
}) {
  const { t } = useTranslation();
  return (
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
            onClick={() => onChange(EASY_SPEEDS[option])}
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
  );
}
