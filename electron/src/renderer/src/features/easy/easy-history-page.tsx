import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { AudioLinesIcon, DownloadIcon, Trash2Icon, Volume2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/features/clone/confirm-dialog';
import { useHistory } from '@/hooks/use-history';
import { deleteHistoryItem } from '@/lib/api/history';
import { describeError } from '@/lib/api/client';
import { queryKeys } from '@/lib/query';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useProfiles } from '@/hooks/use-profiles';
import { audioUrl } from '@/lib/api/client';
import type { HistoryItem } from '@/lib/api/types';
import { EASY_ROUTES } from '@/lib/easy-mode';
import { runRendererTask } from '@/lib/global-error-recovery';
import { easyDate, saveEasyAudioPath } from './easy-audio';
import { EasyEmpty, EasyPage, EasyPlayButton } from './easy-layout';

export function EasyHistoryPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const history = useHistory();
  const profiles = useProfiles();
  const client = useQueryClient();
  const [deleting, setDeleting] = useState<HistoryItem | null>(null);
  const names = new Map((profiles.data ?? []).map((profile) => [profile.id, profile.name]));
  const format = new Intl.DateTimeFormat(i18n.language || undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const items = [...(history.data ?? [])]
    .filter((item) => Boolean(item.audio_path))
    .sort(
      (a, b) => (easyDate(b.created_at)?.getTime() ?? 0) - (easyDate(a.created_at)?.getTime() ?? 0),
    );

  return (
    <EasyPage title={t('easy.history_title')}>
      {history.isLoading ? (
        <div className="flex items-center gap-2 py-10 text-muted-foreground">
          <Spinner className="size-5" />
          {t('easy.loading')}
        </div>
      ) : items.length === 0 ? (
        <EasyEmpty
          icon={<Volume2Icon />}
          title={t('easy.no_history_title')}
          description={t('easy.no_history_body')}
          action={
            <Button
              className="h-12 gap-2 rounded-xl px-5 text-base"
              onClick={() =>
                runRendererTask('Open easy create', () => navigate({ to: EASY_ROUTES.create }))
              }
            >
              <AudioLinesIcon className="size-5" />
              {t('easy.create_title')}
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('easy.history_title')}>
          {items.map((item) => {
            const created = easyDate(item.created_at);
            const voice =
              (item.profile_id && names.get(item.profile_id)) || t('easy.unknown_voice');
            return (
              <li
                key={item.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-2xl border border-border/70 bg-card px-4 py-3 shadow-xs max-sm:gap-x-2 max-sm:gap-y-0.5 max-sm:py-2.5 max-sm:ps-3.5 max-sm:pe-2"
              >
                <p
                  className="col-start-1 row-start-1 line-clamp-2 text-base leading-relaxed max-sm:text-[15px] max-sm:leading-snug"
                  dir="auto"
                >
                  {item.text}
                </p>
                <div className="contents">
                  <p className="col-start-1 row-start-2 min-w-0 text-sm text-muted-foreground max-sm:truncate max-sm:text-[12.5px]">
                    <span className="font-medium text-foreground/80">{voice}</span>
                    {created && <span> · {format.format(created)}</span>}
                    {item.duration_seconds ? (
                      <span>
                        {' · '}
                        {t('easy.seconds', {
                          n: Math.max(1, Math.round(item.duration_seconds)),
                        })}
                      </span>
                    ) : null}
                  </p>
                  <div className="col-start-2 row-span-2 row-start-1 flex flex-wrap items-center gap-1 max-sm:flex-nowrap max-sm:gap-0.5">
                    <EasyPlayButton
                      playKey={`take:${item.id}`}
                      src={audioUrl(item.audio_path)}
                      phoneIcon
                    />
                    <Button
                      variant="ghost"
                      className="h-11 gap-2 rounded-xl px-3 text-[15px] max-sm:size-10 max-sm:rounded-full max-sm:px-0"
                      title={t('easy.save_short')}
                      onClick={() => void saveEasyAudioPath(item.audio_path, created)}
                    >
                      <DownloadIcon className="size-4 max-sm:size-[18px]" />
                      <span className="max-sm:sr-only">{t('easy.save_short')}</span>
                    </Button>
                    <Button
                      variant="ghost"
                      className="h-11 gap-2 rounded-xl px-3 text-[15px] text-destructive hover:bg-destructive/10 hover:text-destructive max-sm:size-10 max-sm:rounded-full max-sm:px-0"
                      title={t('easy.delete')}
                      onClick={() => setDeleting(item)}
                    >
                      <Trash2Icon className="size-4 max-sm:size-[18px]" />
                      <span className="max-sm:sr-only">{t('easy.delete')}</span>
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('easy.delete_take_title')}
        description={t('easy.delete_take_body')}
        confirmLabel={t('easy.delete')}
        cancelLabel={t('easy.cancel')}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await deleteHistoryItem(deleting.id);
            toast.success(t('easy.take_deleted'));
          } catch (error) {
            toast.error(t('easy.delete_failed', { message: describeError(error) }));
          } finally {
            void client.invalidateQueries({ queryKey: queryKeys.history });
          }
        }}
      />
    </EasyPage>
  );
}
