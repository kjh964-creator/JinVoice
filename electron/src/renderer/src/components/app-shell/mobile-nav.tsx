import { useEffect, useRef, useState } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { MenuIcon, SettingsIcon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { brandIcon } from '@/lib/brand';
import { appVersion } from '@/components/bridge';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { WorkspaceNavigation } from './workspace-menu';
import { EasyModeReturnButton } from './easy-mode-return';
import { versionTranslationKey } from './workspace-sidebar';

/**
 * Phones (< 640px) have no room for the icon rail beside a page, so the full
 * workspace shows this slim bar instead: a menu button that opens the same
 * navigation as a drawer, and the brand. Hidden from 640px up, where the rail
 * and sidebar stay exactly as they are.
 */
export function MobileTopBar() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // Any navigation (a drawer link, the command palette, back) closes the drawer.
  useEffect(() => setOpen(false), [pathname]);
  return (
    <>
      <header
        data-slot="mobile-top-bar"
        className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border/50 bg-sidebar pr-[calc(0.5rem+var(--corner-space,0px))] pl-1.5 sm:hidden"
      >
        <Button
          variant="ghost"
          size="icon"
          data-slot="mobile-nav-toggle"
          aria-label={t('nav.open_menu')}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <MenuIcon className="size-5" />
        </Button>
        <Link
          to="/clone"
          className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img src={brandIcon} alt="" className="size-6 shrink-0" />
          <span className="truncate text-[15px] font-semibold tracking-tight">{t('app.name')}</span>
        </Link>
      </header>
      {open && <MobileNavDrawer onClose={() => setOpen(false)} />}
    </>
  );
}

function MobileNavDrawer({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const close = useRef<HTMLButtonElement>(null);
  const versionLabel = t(versionTranslationKey(import.meta.env.DEV), { version: appVersion() });
  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div data-slot="mobile-nav-drawer" className="fixed inset-0 z-[70] sm:hidden">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.primary')}
        // A link to the page already open does not change the route; close anyway.
        onClickCapture={(event) => {
          if ((event.target as HTMLElement).closest('a')) onClose();
        }}
        className="brand-sidebar absolute inset-y-0 left-0 flex w-[min(20rem,86vw)] flex-col border-r border-border/50 bg-sidebar text-sidebar-foreground shadow-2xl"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/50 pr-1.5 pl-3">
          <img src={brandIcon} alt="" className="size-6 shrink-0" />
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[15px] font-semibold tracking-tight">
              {t('app.name')}
            </span>
            <span className="truncate text-[11px] leading-none text-muted-foreground tabular-nums">
              {versionLabel}
            </span>
          </span>
          <Button
            ref={close}
            variant="ghost"
            size="icon"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <XIcon className="size-5" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <WorkspaceNavigation />
        </div>
        <div className="flex shrink-0 flex-col gap-1 border-t border-border/50 p-2">
          <Link
            to="/settings"
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              'workspace-nav-item h-9 justify-start gap-2.5 px-2.5',
            )}
          >
            <SettingsIcon className="workspace-nav-icon" data-tone="settings" />
            {t('nav.settings')}
          </Link>
          <EasyModeReturnButton className="h-9 justify-start gap-2.5 px-2.5" />
        </div>
      </div>
    </div>
  );
}
