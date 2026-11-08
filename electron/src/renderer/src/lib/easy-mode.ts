/**
 * JinVoice easy mode: the whole app is three plain screens (make speech, my
 * voices, made speech) plus Settings for first-run downloads. Every other
 * workspace stays in the code base but is unlinked and redirected home.
 *
 * Flip this to `false` to bring back the full VoiceStudio workspace UI.
 */
export const EASY_MODE: boolean = true;

export const EASY_ROUTES = {
  home: '/',
  create: '/easy/create',
  voices: '/easy/voices',
  newVoice: '/easy/voices/new',
  history: '/easy/history',
} as const;

/**
 * Settings pages easy mode hides: upstream's donation/support-plan page and
 * the VoiceStudio Cloud account page (sign-in, sync, Pro).
 */
const EASY_HIDDEN_SETTINGS = ['/settings/support', '/settings/account'];

/** Routes easy mode shows; anything else is sent back to the easy home. */
export function isEasyModePath(pathname: string): boolean {
  if (
    EASY_HIDDEN_SETTINGS.some((hidden) => pathname === hidden || pathname.startsWith(`${hidden}/`))
  )
    return false;
  return (
    pathname === '/' ||
    pathname === '' ||
    pathname === '/easy' ||
    pathname.startsWith('/easy/') ||
    pathname === '/settings' ||
    pathname.startsWith('/settings/')
  );
}
