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
        'flex min-h-15 min-w-0 items-center gap-2 rounded-2xl border bg-background p-1.5 ps-2.5 transition-colors max-sm:min-h-0 max-sm:gap-0.5 max-sm:p-1.5',
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
        className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-xl text-start outline-none focus-visible:ring-2 focus-visible:ring-ring/40 max-sm:min-h-10 max-sm:gap-1.5"
      >
        <ProfileAvatar
          name={name}
          imageUrl={imageUrl}
          className="size-9 shrink-0 text-sm max-sm:size-7 max-sm:text-[11px]"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span title={name} className="truncate text-base font-medium max-sm:text-sm">
            {name}
          </span>
          {subtitle && (
            <span title={subtitle} className="truncate text-sm text-muted-foreground max-sm:hidden">
              {subtitle}
            </span>
          )}
        </span>
        {selected && (
          <CheckCircle2Icon className="ms-auto size-5 shrink-0 text-primary max-sm:hidden" />
        )}
      </button>
      {playKey && playSrc && (
        <EasyPlayButton playKey={playKey} src={playSrc} size="icon" className="max-sm:size-9" />
      )}
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
      className="grid grid-cols-3 gap-2 rounded-2xl bg-muted/60 p-1.5 max-sm:gap-1 max-sm:p-1"
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
              'h-11 rounded-xl text-base font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40 max-sm:h-10 max-sm:text-[15px]',
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
