import { useNavigate } from '@tanstack/react-router';
import {
  AudioLinesIcon,
  BookOpenTextIcon,
  ChevronRightIcon,
  MicIcon,
  Volume2Icon,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { useHistory } from '@/hooks/use-history';
import { useProfiles } from '@/hooks/use-profiles';
import { EASY_ROUTES } from '@/lib/easy-mode';
import { runRendererTask } from '@/lib/global-error-recovery';
import { easyVoices } from './easy-voices';

type EasyTarget =
  | typeof EASY_ROUTES.create
  | typeof EASY_ROUTES.voices
  | typeof EASY_ROUTES.history
  | typeof EASY_ROUTES.audiobook;

function HomeCard({
  to,
  icon: Icon,
  title,
  description,
  meta,
  accent,
}: {
  to: EasyTarget;
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  meta?: string | null;
  accent: string;
}) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      data-slot="easy-home-card"
      onClick={() => runRendererTask('Open easy screen', () => navigate({ to }))}
      className="group flex min-h-44 flex-row items-start gap-5 rounded-3xl border border-border/70 bg-card p-6 text-start shadow-xs transition-[border-color,box-shadow,transform] outline-none hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring/40 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      <span
        className={`flex size-16 shrink-0 items-center justify-center rounded-2xl ${accent} [&_svg]:size-8`}
      >
        <Icon />
      </span>
      <span className="flex min-h-full min-w-0 flex-1 flex-col gap-1.5 self-stretch">
        <span className="text-xl font-semibold tracking-tight">{title}</span>
        <span className="text-[15px] leading-relaxed text-muted-foreground">{description}</span>
        <span className="mt-auto flex w-full items-center justify-between pt-3 text-sm font-medium">
          <span className="text-muted-foreground">{meta}</span>
          <ChevronRightIcon className="size-5 text-primary transition-transform group-hover:translate-x-0.5" />
        </span>
      </span>
    </button>
  );
}

export function EasyHomePage() {
  const { t } = useTranslation();
  const profiles = useProfiles();
  const history = useHistory();
  const voiceCount = profiles.data ? easyVoices(profiles.data).length : null;
  const takeCount = history.data ? history.data.length : null;
  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center gap-8 px-8 pt-10 pb-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{t('easy.home_title')}</h1>
        <p className="text-base text-muted-foreground">{t('easy.home_subtitle')}</p>
      </div>
      <div data-slot="easy-home-grid" className="grid gap-5 sm:grid-cols-2">
        <HomeCard
          to={EASY_ROUTES.create}
          icon={AudioLinesIcon}
          title={t('easy.create_title')}
          description={t('easy.create_card')}
          accent="bg-primary text-primary-foreground"
        />
        <HomeCard
          to={EASY_ROUTES.audiobook}
          icon={BookOpenTextIcon}
          title={t('easy.audiobook_title')}
          description={t('easy.audiobook_card')}
          accent="bg-primary/12 text-primary"
        />
        <HomeCard
          to={EASY_ROUTES.voices}
          icon={MicIcon}
          title={t('easy.voices_title')}
          description={t('easy.voices_card')}
          meta={voiceCount === null ? null : t('easy.voice_count', { n: voiceCount })}
          accent="bg-primary/12 text-primary"
        />
        <HomeCard
          to={EASY_ROUTES.history}
          icon={Volume2Icon}
          title={t('easy.history_title')}
          description={t('easy.history_card')}
          meta={takeCount === null ? null : t('easy.take_count', { n: takeCount })}
          accent="bg-primary/12 text-primary"
        />
      </div>
    </div>
  );
}
