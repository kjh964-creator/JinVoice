import type { ComponentType, ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  AudioLinesIcon,
  BookOpenTextIcon,
  ChevronRightIcon,
  LayersIcon,
  MicIcon,
  SparklesIcon,
  Volume2Icon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { REF_HARD_MAX_SECONDS } from '@/lib/api/generate';
import { EASY_ROUTES } from '@/lib/easy-mode';
import { runRendererTask } from '@/lib/global-error-recovery';
import { EasyPage } from './easy-layout';
import { EASY_MAX_CHARS } from './easy-voices';

function HelpSection({
  icon: Icon,
  title,
  steps,
  note,
  stepExtra,
  action,
  onAction,
  accent = 'bg-primary/12 text-primary',
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  steps: string[];
  note?: ReactNode;
  /** Shown under one step (index), e.g. the supported file formats. */
  stepExtra?: { index: number; node: ReactNode };
  action: string;
  onAction: () => void;
  accent?: string;
}) {
  return (
    <section
      data-slot="easy-help-section"
      className="rounded-2xl border border-border/70 bg-card p-5 shadow-xs sm:p-6 max-sm:p-4"
    >
      <div className="mb-4 flex items-center gap-4 max-sm:mb-3 max-sm:gap-3">
        <span
          className={`flex size-12 shrink-0 items-center justify-center rounded-2xl ${accent} max-sm:size-10 max-sm:rounded-xl [&_svg]:size-6 max-sm:[&_svg]:size-5`}
        >
          <Icon />
        </span>
        <h2 className="min-w-0 flex-1 text-xl font-semibold tracking-tight max-sm:text-lg max-sm:leading-snug">{title}</h2>
        <Button
          variant="ghost"
          className="h-10 shrink-0 gap-1 rounded-xl px-3 text-[15px] text-primary hover:text-primary max-sm:-me-2 max-sm:px-2 max-sm:text-sm"
          onClick={onAction}
        >
          {action}
          <ChevronRightIcon className="size-4" />
        </Button>
      </div>
      <ol className="flex flex-col gap-3 max-sm:gap-2.5">
        {steps.map((step, index) => (
          <li key={index} className="flex items-start gap-3">
            <span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/12 text-sm font-semibold text-primary tabular-nums">
              {index + 1}
            </span>
            <span className="flex min-w-0 flex-col gap-2 pt-0.5">
              <span className="text-[15px] leading-relaxed max-sm:leading-normal">{step}</span>
              {stepExtra?.index === index && stepExtra.node}
            </span>
          </li>
        ))}
      </ol>
      {note && (
        <p className="mt-4 flex items-start gap-2 rounded-xl bg-primary/6 px-4 py-3 text-[15px] leading-relaxed max-sm:mt-3 max-sm:px-3 max-sm:py-2.5 max-sm:text-sm">
          <SparklesIcon className="mt-1 size-4 shrink-0 text-primary" />
          <span>{note}</span>
        </p>
      )}
    </section>
  );
}

export function EasyHelpPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const go = (to: string) => () => runRendererTask('Open from help', () => navigate({ to }));
  return (
    <EasyPage title={t('easy.help_title')}>
      <div className="flex flex-col gap-5 max-sm:gap-3">
        <p className="text-base text-muted-foreground max-sm:px-1 max-sm:text-sm">{t('easy.help_intro')}</p>
        <HelpSection
          icon={AudioLinesIcon}
          accent="bg-primary text-primary-foreground"
          title={t('easy.help_create_title')}
          steps={[
            t('easy.help_create_1'),
            t('easy.help_create_2', { max: EASY_MAX_CHARS.toLocaleString() }),
            t('easy.help_create_3'),
            t('easy.help_create_4'),
          ]}
          action={t('easy.help_open')}
          onAction={go(EASY_ROUTES.create)}
        />
        <HelpSection
          icon={MicIcon}
          title={t('easy.help_voice_title')}
          steps={[
            t('easy.help_voice_1'),
            t('easy.help_voice_2'),
            t('easy.help_voice_3', { max: REF_HARD_MAX_SECONDS }),
            t('easy.help_voice_4'),
          ]}
          stepExtra={{
            index: 1,
            node: (
              <span className="self-start rounded-lg border border-border/70 bg-background px-3 py-1.5 text-sm font-medium text-muted-foreground">
                {t('easy.help_voice_formats')}
              </span>
            ),
          }}
          note={t('easy.help_voice_tip')}
          action={t('easy.help_open')}
          onAction={go(EASY_ROUTES.voices)}
        />
        <HelpSection
          icon={BookOpenTextIcon}
          title={t('easy.help_book_title')}
          steps={[
            t('easy.help_book_1'),
            t('easy.help_book_2'),
            t('easy.help_book_3'),
            t('easy.help_book_4'),
          ]}
          action={t('easy.help_open')}
          onAction={go(EASY_ROUTES.audiobook)}
        />
        <HelpSection
          icon={Volume2Icon}
          title={t('easy.help_history_title')}
          steps={[t('easy.help_history_1'), t('easy.help_history_2')]}
          action={t('easy.help_open')}
          onAction={go(EASY_ROUTES.history)}
        />
        <HelpSection
          icon={LayersIcon}
          accent="bg-muted text-foreground"
          title={t('easy.help_more_title')}
          steps={[t('easy.help_more_1'), t('easy.help_more_2'), t('easy.help_more_3')]}
          action={t('easy.help_open_settings')}
          onAction={go('/settings/general')}
        />
      </div>
    </EasyPage>
  );
}
