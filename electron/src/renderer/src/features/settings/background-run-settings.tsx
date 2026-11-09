import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getBridge } from '@/components/bridge';
import { Switch } from '@/components/ui/switch';
import { SettingsRow } from './settings-layout';

type BackgroundRunState = {
  closeToTray: boolean;
  openAtLogin: boolean;
  closeToTraySupported: boolean;
  openAtLoginSupported: boolean;
};
type Patch = { closeToTray?: boolean; openAtLogin?: boolean };

/**
 * Settings → General (also in easy mode): keep JinVoice in the notification
 * area when the window is closed, and optionally start it there at login.
 * Rendered only inside the Windows/Linux desktop app.
 */
export function BackgroundRunSettings() {
  const { t } = useTranslation();
  const bridge = getBridge();
  const api = bridge?.app.platform === 'darwin' ? undefined : bridge?.app.background;
  const [state, setState] = useState<BackgroundRunState | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!api) return;
    let live = true;
    api
      .get()
      .then((next) => {
        if (live) setState(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api]);

  if (!api || !state || (!state.closeToTraySupported && !state.openAtLoginSupported)) return null;

  const update = (patch: Patch) => {
    const previous = state;
    setState({ ...state, ...patch });
    setSaving(true);
    api
      .set(patch)
      .then(setState)
      .catch(() => setState(previous))
      .finally(() => setSaving(false));
  };

  return (
    <>
      {state.closeToTraySupported && (
        <SettingsRow
          id="close-to-tray-label"
          title={t('backgroundRun.close_to_tray')}
          description={t('backgroundRun.close_to_tray_desc', { app: t('app.name') })}
        >
          <Switch
            data-slot="close-to-tray-switch"
            aria-labelledby="close-to-tray-label"
            checked={state.closeToTray}
            disabled={saving}
            onCheckedChange={(closeToTray) => update({ closeToTray })}
          />
        </SettingsRow>
      )}
      {state.openAtLoginSupported && (
        <SettingsRow
          id="open-at-login-label"
          title={t('backgroundRun.open_at_login', { app: t('app.name') })}
          description={t('backgroundRun.open_at_login_desc')}
        >
          <Switch
            data-slot="open-at-login-switch"
            aria-labelledby="open-at-login-label"
            checked={state.openAtLogin}
            disabled={saving}
            onCheckedChange={(openAtLogin) => update({ openAtLogin })}
          />
        </SettingsRow>
      )}
    </>
  );
}
