import { SparklesIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { setEasyModeEnabled } from '@/lib/easy-mode';
import { runRendererTask } from '@/lib/global-error-recovery';
import { cn } from '@/lib/utils';

/**
 * Turn easy mode back on and open the easy home. The router is loaded lazily
 * so shell components can show this button without a router import cycle.
 */
export function returnToEasyMode(): void {
  setEasyModeEnabled(true);
  runRendererTask('Back to easy screen', async () => {
    const { router } = await import('@/router');
    await router.navigate({ to: '/' });
  });
}

/**
 * JinVoice: the full workspace's way back to the easy screens (sidebar footer,
 * compact rail and the workspace top bar).
 */
export function EasyModeReturnButton({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const label = t('easy.back_to_easy');
  return (
    <Button
      type="button"
      data-slot="easy-mode-return"
      variant="ghost"
      size={compact ? 'icon-sm' : 'sm'}
      aria-label={label}
      title={t('easy.back_to_easy_hint')}
      onClick={returnToEasyMode}
      className={cn(
        'workspace-nav-item text-primary hover:text-primary',
        !compact && 'min-w-0 shrink gap-1.5',
        className,
      )}
    >
      <SparklesIcon className="workspace-nav-icon size-4 shrink-0" />
      {!compact && <span className="min-w-0 truncate">{label}</span>}
    </Button>
  );
}
