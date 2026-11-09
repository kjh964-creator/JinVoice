import { InfoIcon, ToggleRightIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Switch } from '@/components/ui/switch';
import { setEasyFeatureEnabled, useEasyFeatures } from '@/lib/easy-features';
import { useEasyMode } from '@/lib/easy-mode';
import { cn } from '@/lib/utils';
import { EASY_FEATURE_CATALOG } from './easy-feature-catalog';

/**
 * Settings → General: one on/off switch per original workspace. A switched-on
 * feature appears on the easy home under "More features" and opens inside easy
 * mode; while the full UI is shown everything is visible anyway, so the list
 * stays editable and says so.
 */
export function EasyFeatureSettings({ variant = 'settings' }: { variant?: 'settings' | 'page' }) {
  const { t } = useTranslation();
  const easyMode = useEasyMode();
  const enabled = useEasyFeatures();
  const page = variant === 'page';
  const count = (
    <span
      data-slot="easy-features-count"
      className="ms-auto rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium whitespace-nowrap text-primary"
    >
      {t('easy.features_on_count', { n: enabled.length, total: EASY_FEATURE_CATALOG.length })}
    </span>
  );
  return (
    <section
      data-slot="easy-feature-settings"
      data-variant={variant}
      aria-labelledby={page ? undefined : 'easy-features-label'}
      aria-label={page ? t('easy.features_title') : undefined}
      className="min-w-0 space-y-2.5"
    >
      {!page && (
        <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 px-1">
          <h2
            id="easy-features-label"
            tabIndex={-1}
            className="flex items-center gap-2 text-sm font-normal tracking-[-0.005em] text-foreground/80"
          >
            <ToggleRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            {t('easy.features_title')}
          </h2>
          {count}
        </div>
      )}
      <div
        className={cn(
          'overflow-hidden rounded-2xl border',
          page
            ? 'border-border/70 bg-card shadow-xs'
            : 'glass-panel border-border/60 bg-card/40 shadow-xs/5',
        )}
      >
        <div
          className={cn(
            'space-y-2 border-b border-border/50 px-4',
            page ? 'py-4 sm:px-5 max-sm:py-3' : 'py-3.5',
          )}
        >
          <div className="flex flex-col items-start gap-2 sm:flex-row-reverse sm:gap-3">
            {page && count}
            <p
              className={cn(
                'min-w-0 flex-1 leading-relaxed text-muted-foreground',
                page ? 'text-[15px] max-sm:text-sm' : 'text-[13.5px]',
              )}
            >
              {t('easy.features_desc')}
            </p>
          </div>
          {!easyMode && (
            <p
              data-slot="easy-features-all-visible"
              role="note"
              className="flex items-start gap-2 rounded-xl bg-primary/8 px-3 py-2.5 text-[13px] leading-relaxed text-foreground/85"
            >
              <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
              {t('easy.features_all_visible')}
            </p>
          )}
        </div>
        <ul className="divide-y divide-border/50">
          {EASY_FEATURE_CATALOG.map(({ id, icon: Icon, nameKey, descKey }) => {
            const on = enabled.includes(id);
            const nameId = `easy-feature-${id}-name`;
            return (
              <li key={id}>
                <label
                  data-slot="easy-feature-row"
                  data-feature={id}
                  data-on={on || undefined}
                  className={cn(
                    'flex cursor-pointer items-center gap-3.5 px-4 transition-colors hover:bg-muted/40 sm:gap-4',
                    page ? 'py-3.5 sm:px-5 max-sm:gap-3 max-sm:py-2.5' : 'py-3',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex size-11 shrink-0 items-center justify-center rounded-xl transition-colors [&_svg]:size-5',
                      page && 'max-sm:size-10',
                      on ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    <Icon />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      id={nameId}
                      className={cn(
                        'block font-semibold tracking-tight',
                        page ? 'text-base max-sm:text-[15px]' : 'text-[15px]',
                      )}
                    >
                      {t(nameKey)}
                    </span>
                    <span
                      className={cn(
                        'block leading-snug text-muted-foreground',
                        page ? 'text-sm max-sm:text-[13px]' : 'text-[13px]',
                      )}
                    >
                      {t(descKey)}
                    </span>
                  </span>
                  <span
                    data-slot="easy-feature-state"
                    aria-hidden="true"
                    className={cn(
                      'w-12 shrink-0 text-end text-[13px] font-medium',
                      on ? 'text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {on ? t('easy.feature_on') : t('easy.feature_off')}
                  </span>
                  <Switch
                    data-slot="easy-feature-switch"
                    aria-labelledby={nameId}
                    checked={on}
                    onCheckedChange={(next) => setEasyFeatureEnabled(id, next)}
                    className="shrink-0"
                  />
                </label>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
