import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/bridge', () => ({ isMac: () => true }));
vi.mock('./support-shortcut', () => ({ SupportShortcut: () => null }));
vi.mock('./sidebar-toggle', () => ({ SidebarToggle: () => null }));

import { setEasyModeEnabled } from '@/lib/easy-mode';
import { WorkspaceHeader } from './workspace-header';

afterEach(cleanup);

function Page({ pane, collapsed = false }: { pane?: string; collapsed?: boolean }) {
  return (
    <div>
      <WorkspaceHeader>
        <h1>Design</h1>
      </WorkspaceHeader>
      <div>
        {pane && (
          <aside
            data-slot="secondary-sidebar"
            aria-label={pane}
            data-collapsed={collapsed || undefined}
          />
        )}
      </div>
    </div>
  );
}

const header = () => document.querySelector('[data-slot="workspace-header"]')!;

it('shows the title once: in the page pane while it is open, in the shell otherwise', async () => {
  const view = render(<Page pane="Design" />);
  // The heading stays in the document for assistive tech either way.
  expect(screen.getByRole('heading', { name: 'Design', level: 1 })).toBeInTheDocument();
  expect(header()).toHaveAttribute('data-title', 'pane');

  await act(async () => view.rerender(<Page pane="Design" collapsed />));
  expect(header()).toHaveAttribute('data-title', 'shell');

  await act(async () => view.rerender(<Page pane="History" />));
  expect(header()).toHaveAttribute('data-title', 'shell');

  await act(async () => view.rerender(<Page />));
  expect(header()).toHaveAttribute('data-title', 'shell');
});

it('keeps every header control on the 28px title bar row', () => {
  render(<Page />);
  expect(screen.getByRole('button', { name: 'preferences.search' })).toHaveClass('h-7');
});

it('lets a page item pushed right sit beside search instead of mid-bar', () => {
  render(
    <WorkspaceHeader>
      <h1>Home</h1>
      <a href="#/projects" className="ms-auto">
        Projects
      </a>
    </WorkspaceHeader>,
  );
  // Page items share one growing row, so only one auto margin competes for the free space.
  expect(screen.getByRole('link', { name: 'Projects' }).parentElement).toHaveClass('flex-1');
  expect(screen.getByRole('button', { name: 'preferences.search' }).parentElement).not.toHaveClass(
    'ml-auto',
  );
});

it('shows the JinVoice way back to the easy screen in the full UI top bar', () => {
  setEasyModeEnabled(false);
  try {
    render(<Page />);
    const back = screen.getByRole('button', { name: 'easy.back_to_easy' });
    expect(back).toHaveClass('h-7');
    expect(back).toHaveTextContent('easy.back_to_easy');
  } finally {
    setEasyModeEnabled(true);
  }
});
