import { SupportShortcut } from './support-shortcut';
import { SidebarToggle } from './sidebar-toggle';
import { EasyModeReturnButton } from './easy-mode-return';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SearchIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { isMac } from '@/components/bridge';
import { useEasyMode } from '@/lib/easy-mode';

/**
 * True while the page shows its own pane titled exactly like the shell title, so
 * the title is shown once: in the pane when it is open, in the shell otherwise.
 */
export function titleShownByPane(header: HTMLElement): boolean {
  const title = header.querySelector('h1')?.textContent?.trim();
  const pane = header.parentElement?.querySelector<HTMLElement>(
    '[data-slot="secondary-sidebar"]:not([data-collapsed])',
  );
  return Boolean(title && pane?.getAttribute('aria-label')?.trim() === title);
}

export function WorkspaceHeader({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  // JinVoice: a feature switched on in easy mode opens under the easy bar, which
  // already has the way home; upstream's Pro/star shortcuts lead to hidden pages.
  const easyMode = useEasyMode();
  const header = useRef<HTMLElement>(null);
  const [paneTitled, setPaneTitled] = useState(false);
  // Re-checks on every render (title text, language) and whenever the pane opens or collapses.
  useEffect(() => {
    const node = header.current;
    if (node) setPaneTitled(titleShownByPane(node));
  });
  useEffect(() => {
    const node = header.current;
    const scope = node?.parentElement;
    if (!node || !scope || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => setPaneTitled(titleShownByPane(node)));
    observer.observe(scope, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-collapsed', 'aria-label'],
    });
    return () => observer.disconnect();
  }, []);
  return (
    <header
      ref={header}
      data-slot="workspace-header"
      data-title={paneTitled ? 'pane' : 'shell'}
      className={cn(
        'workspace-titlebar flex shrink-0 items-center gap-3 border-b border-border/50 px-5',
        !isMac() && 'native-controls-right',
      )}
    >
      {!isMac() && <SidebarToggle />}
      {/* The page's own items fill the bar, so one pushed right with ms-auto sits beside
          search instead of splitting the free space with it. */}
      <div
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3',
          // One title style on every page; the h1 stays for assistive tech when the pane shows it.
          '[&>h1]:min-w-0 [&>h1]:truncate [&>h1]:text-[13px] [&>h1]:font-medium [&>h1]:text-foreground/90',
          paneTitled && '[&>h1]:sr-only',
        )}
      >
        {children}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {/* JinVoice: one click back to the easy screens. */}
        {!easyMode && <EasyModeReturnButton className="h-7 px-2 text-xs font-medium" />}
        {!easyMode && <SupportShortcut />}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
          aria-label={t('preferences.search')}
          title={isMac() ? 'Command + K' : 'Ctrl + K'}
          onClick={() => window.dispatchEvent(new Event('voicestudio:commands'))}
        >
          <SearchIcon />
          <span className="hidden text-xs font-medium lg:inline">{isMac() ? '⌘K' : 'Ctrl K'}</span>
        </Button>
      </div>
    </header>
  );
}
