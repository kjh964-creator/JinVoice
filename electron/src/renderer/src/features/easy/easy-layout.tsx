import { useEffect, useRef, type ReactNode } from 'react';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { ArrowLeftIcon, CircleHelpIcon, PauseIcon, PlayIcon, SettingsIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getBridge, isMac } from '@/components/bridge';
import { Button } from '@/components/ui/button';
import { brandIcon } from '@/lib/brand';
import { EASY_ROUTES } from '@/lib/easy-mode';
import { runRendererTask } from '@/lib/global-error-recovery';
import { cn } from '@/lib/utils';
import { toggleEasyPlayback, useEasyPlaying, type EasyPlayRange } from './easy-audio';
import { EasyWebSession } from './easy-web-session';

/** The whole easy-mode frame: logo + name, and small Help and Settings buttons. */
export function EasyTopBar({
  settingsActive = false,
  helpActive = false,
  backHome = false,
}: {
  settingsActive?: boolean;
  helpActive?: boolean;
  /** An original workspace opened from the easy home: show a big way back. */
  backHome?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <header
      data-slot="easy-top-bar"
      className={cn(
        'workspace-titlebar flex shrink-0 items-center gap-3 border-b border-border/50 px-5',
        // The 148px right gap is for the desktop window buttons; a browser has none,
        // and on a phone that gap squeezed the logo and buttons together.
        isMac() ? 'ps-22' : getBridge() ? 'native-controls-right' : 'px-3 sm:px-5',
      )}
    >
      <Link
        to={EASY_ROUTES.home}
        className="flex min-w-0 shrink-0 items-center gap-2.5 rounded-lg px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 max-sm:gap-2"
        aria-label={t('easy.go_home')}
      >
        <img src={brandIcon} alt="" className="size-7 max-sm:size-6.5" draggable={false} />
        <span
          className={cn(
            'text-[17px] font-semibold tracking-tight whitespace-nowrap max-sm:text-base',
            backHome && 'max-sm:sr-only',
          )}
        >
          {t('easy.app_name')}
        </span>
      </Link>
      {backHome && (
        <Button
          data-slot="easy-back-home"
          variant="outline"
          size="lg"
          className="gap-2 rounded-xl px-3.5 max-sm:h-10 max-sm:px-3"
          onClick={() =>
            runRendererTask('Back to easy home', () => navigate({ to: EASY_ROUTES.home }))
          }
        >
          <ArrowLeftIcon className="size-4" />
          {t('easy.back_home')}
        </Button>
      )}
      <div className="ms-auto flex items-center gap-1 max-sm:gap-0.5">
        <EasyWebSession />
        <Button
          data-slot="easy-help-button"
          variant={helpActive ? 'secondary' : 'ghost'}
          size="lg"
          className="gap-2 px-3 max-sm:size-10 max-sm:rounded-full max-sm:px-0"
          aria-current={helpActive ? 'page' : undefined}
          title={t('easy.help')}
          onClick={() =>
            runRendererTask('Open easy help', () => navigate({ to: EASY_ROUTES.help }))
          }
        >
          <CircleHelpIcon className="size-4 max-sm:size-5" />
          <span className="max-sm:sr-only">{t('easy.help')}</span>
        </Button>
        <Button
          variant={settingsActive ? 'secondary' : 'ghost'}
          size="lg"
          className="gap-2 px-3 max-sm:size-10 max-sm:rounded-full max-sm:px-0"
          aria-current={settingsActive ? 'page' : undefined}
          title={t('easy.settings')}
          onClick={() => runRendererTask('Open settings', () => navigate({ to: '/settings' }))}
        >
          <SettingsIcon className="size-4 max-sm:size-5" />
          <span className="max-sm:sr-only">{t('easy.settings')}</span>
        </Button>
      </div>
    </header>
  );
}

export function EasyShell({ pathname = '' }: { pathname?: string }) {
  const main = useRef<HTMLElement>(null);
  // Every easy screen starts at its top, even when opened from far down the home.
  useEffect(() => {
    main.current?.scrollTo?.({ top: 0 });
  }, [pathname]);
  return (
    <div data-slot="easy-shell" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <EasyTopBar helpActive={pathname === EASY_ROUTES.help} />
      <main
        ref={main}
        data-slot="workspace-content"
        className="studio-scrollbar min-h-0 flex-1 overflow-y-auto bg-background break-keep"
      >
        <Outlet />
      </main>
    </div>
  );
}

/** A subpage: a fixed "← Home" button and the page title above the content. */
export function EasyPage({
  title,
  actions,
  children,
  backTo = EASY_ROUTES.home,
  backLabel,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  backTo?: string;
  backLabel?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="flex min-h-full flex-col">
      <div className="sticky top-0 z-10 border-b border-border/40 bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-4 px-6 py-3.5 max-sm:gap-2.5 max-sm:px-3 max-sm:py-2">
          <Button
            variant="outline"
            className="h-11 gap-2 rounded-xl px-4 text-[15px] max-sm:size-10 max-sm:rounded-full max-sm:px-0"
            title={backLabel ?? t('easy.home')}
            onClick={() => runRendererTask('Easy back', () => navigate({ to: backTo }))}
          >
            <ArrowLeftIcon className="size-5" />
            <span className="max-sm:sr-only">{backLabel ?? t('easy.home')}</span>
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-2xl font-semibold tracking-tight max-sm:text-[21px]">
            {title}
          </h1>
          {actions}
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl flex-1 px-6 pt-6 pb-12 max-sm:px-3 max-sm:pt-3 max-sm:pb-8">
        {children}
      </div>
    </div>
  );
}

export function EasySection({
  step,
  title,
  hint,
  children,
  className,
}: {
  step?: number;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'rounded-2xl border border-border/70 bg-card p-5 shadow-xs sm:p-6 max-sm:p-3',
        className,
      )}
    >
      <div className="mb-4 flex items-center gap-3 max-sm:mb-3 max-sm:gap-2.5">
        {step !== undefined && (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/12 text-sm font-semibold text-primary max-sm:size-7 max-sm:text-[13px]">
            {step}
          </span>
        )}
        <h2 className="text-lg font-semibold max-sm:text-[17px]">{title}</h2>
        {hint && (
          <div className="ms-auto text-sm text-muted-foreground max-sm:text-[13px]">{hint}</div>
        )}
      </div>
      {children}
    </section>
  );
}

export function EasyEmpty({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-card/60 px-6 py-12 text-center max-sm:gap-2 max-sm:px-4 max-sm:py-8">
      <div className="flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary max-sm:size-14 [&_svg]:size-8 max-sm:[&_svg]:size-7">
        {icon}
      </div>
      <p className="text-lg font-semibold">{title}</p>
      {description && <p className="max-w-sm text-[15px] text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function EasyPlayButton({
  playKey,
  src,
  label,
  size = 'default',
  disabled,
  range,
  phoneIcon = false,
  className,
}: {
  playKey: string;
  src: string | null | undefined;
  label?: string;
  size?: 'default' | 'large' | 'icon';
  disabled?: boolean;
  range?: EasyPlayRange;
  /** On phones show only the round icon (the label stays for screen readers). */
  phoneIcon?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const playing = useEasyPlaying(playKey);
  const text = playing ? t('easy.stop') : (label ?? t('easy.play'));
  const Icon = playing ? PauseIcon : PlayIcon;
  if (size === 'icon')
    return (
      <Button
        variant="outline"
        className={cn('size-11 rounded-full max-sm:size-10', className)}
        aria-label={text}
        title={text}
        aria-pressed={playing}
        disabled={disabled || !src}
        onClick={() => src && toggleEasyPlayback(playKey, src, range)}
      >
        <Icon className="size-5" />
      </Button>
    );
  return (
    <Button
      variant={size === 'large' ? 'default' : 'outline'}
      className={cn(
        'gap-2 rounded-xl',
        size === 'large' ? 'h-12 px-5 text-base max-sm:h-11 max-sm:px-4 max-sm:text-[15px]' : 'h-11 px-4 text-[15px]',
        phoneIcon && 'max-sm:size-10 max-sm:rounded-full max-sm:px-0',
      )}
      title={phoneIcon ? text : undefined}
      aria-pressed={playing}
      disabled={disabled || !src}
      onClick={() => src && toggleEasyPlayback(playKey, src, range)}
    >
      <Icon className={cn('size-5', phoneIcon && 'max-sm:size-[18px]')} />
      {phoneIcon ? <span className="max-sm:sr-only">{text}</span> : text}
    </Button>
  );
}
