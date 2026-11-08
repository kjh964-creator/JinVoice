import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { DownloadIcon, MicIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ProfileAvatar } from '@/components/profile-avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/features/clone/confirm-dialog';
import { useProfiles } from '@/hooks/use-profiles';
import { deleteProfile } from '@/lib/api/profiles';
import { cloneSettingsStore, setCloneSetting } from '@/lib/store/clone-settings';
import { apiJson, describeError, profileAudioUrl } from '@/lib/api/client';
import type { Profile } from '@/lib/api/types';
import { EASY_ROUTES } from '@/lib/easy-mode';
import { runRendererTask } from '@/lib/global-error-recovery';
import { queryKeys } from '@/lib/query';
import { easyDate, saveEasyVoice } from './easy-audio';
import { EasyEmpty, EasyPage, EasyPlayButton } from './easy-layout';
import { easyVoices } from './easy-voices';

function RenameDialog({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [name, setName] = useState(profile.name);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const next = name.trim();
    if (!next) return;
    setSaving(true);
    try {
      await apiJson<Profile>(`/profiles/${encodeURIComponent(profile.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ name: next }),
      });
      await client.invalidateQueries({ queryKey: queryKeys.profiles });
      toast.success(t('easy.renamed'));
      onClose();
    } catch (error) {
      toast.error(t('easy.rename_failed', { message: describeError(error) }));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-lg">{t('easy.rename_title')}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Input
            autoFocus
            aria-label={t('easy.voice_name')}
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            className="h-12 rounded-xl px-4 text-base md:text-base"
          />
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" className="h-11 px-4" onClick={onClose}>
              {t('easy.cancel')}
            </Button>
            <Button type="submit" className="h-11 px-5" disabled={saving || !name.trim()}>
              {t('easy.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EasyVoicesPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const profiles = useProfiles();
  const client = useQueryClient();
  const voices = easyVoices(profiles.data);
  const [renaming, setRenaming] = useState<Profile | null>(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  const dateFormat = new Intl.DateTimeFormat(i18n.language || undefined, { dateStyle: 'medium' });
  const openRegister = () =>
    runRendererTask('Open voice registration', () => navigate({ to: EASY_ROUTES.newVoice }));

  return (
    <EasyPage
      title={t('easy.voices_title')}
      actions={
        voices.length > 0 ? (
          <Button className="h-11 gap-2 rounded-xl px-4 text-[15px]" onClick={openRegister}>
            <PlusIcon className="size-5" />
            {t('easy.register_voice')}
          </Button>
        ) : undefined
      }
    >
      {profiles.isLoading ? (
        <div className="flex items-center gap-2 py-10 text-muted-foreground">
          <Spinner className="size-5" />
          {t('easy.loading')}
        </div>
      ) : voices.length === 0 ? (
        <EasyEmpty
          icon={<MicIcon />}
          title={t('easy.no_voices_title')}
          description={t('easy.no_voices_body')}
          action={
            <Button className="h-12 gap-2 rounded-xl px-5 text-base" onClick={openRegister}>
              <PlusIcon className="size-5" />
              {t('easy.register_voice')}
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col gap-3" aria-label={t('easy.voices_title')}>
          {voices.map((voice) => {
            const created = easyDate(voice.created_at);
            return (
              <li
                key={voice.id}
                className="flex flex-wrap items-center gap-4 rounded-2xl border border-border/70 bg-card p-4 shadow-xs"
              >
                <ProfileAvatar
                  name={voice.name}
                  imageUrl={voice.image_url}
                  className="size-12 text-base"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-lg font-semibold">{voice.name}</p>
                  {created && (
                    <p className="text-sm text-muted-foreground">
                      {t('easy.registered_on', { date: dateFormat.format(created) })}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <EasyPlayButton
                    playKey={`voice:${voice.id}`}
                    src={profileAudioUrl(voice.id, voice.audio_url)}
                  />
                  <Button
                    variant="ghost"
                    className="h-11 gap-2 rounded-xl px-3 text-[15px]"
                    onClick={() =>
                      void saveEasyVoice(profileAudioUrl(voice.id, voice.audio_url), voice.name)
                    }
                  >
                    <DownloadIcon className="size-4" />
                    {t('easy.save_short')}
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-11 gap-2 rounded-xl px-3 text-[15px]"
                    onClick={() => setRenaming(voice)}
                  >
                    <PencilIcon className="size-4" />
                    {t('easy.rename')}
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-11 gap-2 rounded-xl px-3 text-[15px] text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setDeleting(voice)}
                  >
                    <Trash2Icon className="size-4" />
                    {t('easy.delete')}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {renaming && (
        <RenameDialog key={renaming.id} profile={renaming} onClose={() => setRenaming(null)} />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('easy.delete_voice_title', { name: deleting?.name ?? '' })}
        description={t('easy.delete_voice_body')}
        confirmLabel={t('easy.delete')}
        cancelLabel={t('easy.cancel')}
        onConfirm={async () => {
          if (!deleting) return;
          const id = deleting.id;
          try {
            await deleteProfile(id);
            if (cloneSettingsStore.state.selectedProfileId === id)
              setCloneSetting('selectedProfileId', null);
            toast.success(t('easy.voice_deleted'));
          } catch (error) {
            toast.error(t('easy.delete_failed', { message: describeError(error) }));
          } finally {
            void client.invalidateQueries({ queryKey: queryKeys.profiles });
          }
        }}
      />
    </EasyPage>
  );
}
