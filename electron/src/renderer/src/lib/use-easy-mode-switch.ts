import { useNavigate } from '@tanstack/react-router';
import { setEasyModeEnabled } from '@/lib/easy-mode';
import { runRendererTask } from '@/lib/global-error-recovery';

/**
 * Turn easy mode on or off and land on the home screen of the chosen mode.
 * The root route guard re-reads the preference on that navigation, so the
 * switch applies at once with no restart.
 */
export function useEasyModeSwitch(): (easy: boolean) => void {
  const navigate = useNavigate();
  return (easy: boolean) => {
    setEasyModeEnabled(easy);
    runRendererTask('Switch easy mode', () => navigate({ to: '/' }));
  };
}
