import { WorkspaceSidebar } from './workspace-sidebar';
import { ContextSidebar } from './context-sidebar';
import { CommandPalette } from '@/components/command-palette';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { BackendGate } from '../backend-gate';
import { RepairAgentDock } from './repair-agent-dock';
import { isMac } from '../bridge';
import { cn } from '@/lib/utils';
import { useBackendStatus } from '@/hooks/use-backend-status';
import { isBackendReachable } from '@shared/utils/backendStage';
import { AccountCorner } from './account-corner';
import { NowPlayingDock } from '@/components/now-playing-dock';
import { useEasyMode } from '@/lib/easy-mode';
import { isEnabledEasyFeaturePath, useEasyFeatures } from '@/lib/easy-features';
import { EasyShell, EasyTopBar } from '@/features/easy/easy-layout';

/**
 * Easy mode frame: only the JinVoice bar (logo, name, Settings) and the page.
 * No sidebars, command palette, account corner, agent docks or now-playing
 * dock; the first-run setup gate stays exactly as in the full shell.
 */
function EasyAppShell({ pathname }: { pathname: string }) {
  const settings = pathname.startsWith('/settings');
  // An original workspace the user switched on (Settings → General → feature
  // switches) opens as it is, under the easy bar with a big "back home" button.
  const feature = isEnabledEasyFeaturePath(pathname, useEasyFeatures());
  return (
    <div className="app-surface relative flex h-full flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        {feature ? (
          <div data-slot="easy-feature-frame" className="flex min-h-0 min-w-0 flex-1 flex-col">
            <EasyTopBar backHome />
            <div className="flex min-h-0 min-w-0 flex-1">
              <BackendGate repairDock={<RepairAgentDock />}>
                <ContextSidebar />
                <main
                  data-slot="workspace-content"
                  className="@container relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                >
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <Outlet />
                  </div>
                  <RepairAgentDock />
                </main>
              </BackendGate>
            </div>
          </div>
        ) : settings ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <EasyTopBar settingsActive />
            <main
              data-slot="workspace-content"
              className="@container relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            >
              <div className="min-h-0 flex-1 overflow-hidden">
                <Outlet />
              </div>
            </main>
          </div>
        ) : (
          <BackendGate repairDock={<RepairAgentDock />}>
            <EasyShell pathname={pathname} />
          </BackendGate>
        )}
      </div>
      {feature && <NowPlayingDock />}
    </div>
  );
}

export function AppShell() {
  const backend = useBackendStatus();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const easyMode = useEasyMode();
  if (easyMode) return <EasyAppShell pathname={pathname} />;
  const shellOnly = pathname.startsWith('/settings') || pathname === '/pro';
  const macWorkspace = isMac() && !shellOnly;
  const SettingsWorkspace = pathname === '/settings/openapi' ? 'div' : 'main';
  return (
    <div
      className={cn(
        'app-surface relative flex h-full flex-col bg-background text-foreground',
        macWorkspace && 'macos-notification-safe-area',
      )}
    >
      <div className="flex min-h-0 flex-1">
        {shellOnly ? (
          <>
            <CommandPalette />
            {/* The main sidebar (navigation, library, status) stays where it is
                on Settings too, so the app never swaps its left column. */}
            <WorkspaceSidebar />
            <SettingsWorkspace
              data-slot="workspace-content"
              role={pathname === '/settings/openapi' ? 'main' : undefined}
              className="@container relative flex min-w-0 flex-1 flex-col overflow-hidden"
            >
              <div className="min-h-0 flex-1 overflow-hidden">
                <Outlet />
              </div>
              <RepairAgentDock />
            </SettingsWorkspace>
          </>
        ) : (
          <BackendGate repairDock={<RepairAgentDock />}>
            <CommandPalette />
            <WorkspaceSidebar />
            <ContextSidebar />
            <main
              data-slot="workspace-content"
              className="@container relative flex min-w-0 flex-1 flex-col overflow-hidden"
            >
              <div className="min-h-0 flex-1 overflow-hidden">
                <Outlet />
              </div>
              <RepairAgentDock />
            </main>
          </BackendGate>
        )}
      </div>
      <NowPlayingDock />
      {/* Native drag-region hit testing follows document order. Keep these
          no-drag controls after every workspace titlebar, outside BackendGate. */}
      {/* Top-right corner on every page and platform: account, then the notifications bell. */}
      <AccountCorner notificationsEnabled={isBackendReachable(backend.stage)} />
    </div>
  );
}
