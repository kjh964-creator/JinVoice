import { useEffect, useState } from 'react';
import { LogOutIcon, UserRoundIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { basePathPrefix } from '@shared/utils/publicBase';

/**
 * Web server only (imist.co.kr/jinvoice/app/): the site gate puts a signed
 * cookie on /jinvoice and answers /jinvoice/me with who is signed in. The
 * desktop and Android apps have no such page, so they never show this.
 */
export function jinvoiceWebRoot(prefix: string = basePathPrefix()): string | null {
  const match = /^(.*\/jinvoice)\/app\/?$/.exec(prefix);
  return match ? match[1] : null;
}

export function useWebSession(root: string | null = jinvoiceWebRoot()) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (!root || typeof fetch !== 'function') return;
    let alive = true;
    fetch(`${root}/me`, { credentials: 'same-origin', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { logged_in?: boolean; name?: string | null } | null) => {
        if (alive && data?.logged_in && data.name) setName(data.name);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [root]);
  return { name, logoutUrl: root ? `${root}/logout` : null };
}

/** "Name · Log out" in the easy top bar; on narrow screens only the button. */
export function EasyWebSession({ root }: { root?: string | null }) {
  const { t } = useTranslation();
  const { name, logoutUrl } = useWebSession(root === undefined ? jinvoiceWebRoot() : root);
  if (!name || !logoutUrl) return null;
  return (
    <div data-slot="easy-web-session" data-jv-session="" className="flex items-center gap-1">
      <span
        className="hidden items-center gap-1.5 rounded-full bg-muted/60 px-3 py-1.5 text-sm text-muted-foreground md:inline-flex"
        title={t('easy.signed_in_as', { name })}
      >
        <UserRoundIcon className="size-4" />
        <span className="max-w-[10rem] truncate">{t('easy.signed_in_as', { name })}</span>
      </span>
      <a
        href={logoutUrl}
        className="inline-flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
        title={t('easy.signed_in_as', { name })}
      >
        <LogOutIcon className="size-4" />
        {t('easy.logout')}
      </a>
    </div>
  );
}
