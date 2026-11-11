import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ pathname: '/clone' }));
vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: any) => select({ location: route }),
  Link: ({ children, to, ...props }: any) => (
    <a href={to} {...props} onClick={(event) => event.preventDefault()}>
      {children}
    </a>
  ),
}));
vi.mock('./workspace-menu', () => ({
  WorkspaceNavigation: () => (
    <nav aria-label="Workspaces">
      <a href="/design" onClick={(event) => event.preventDefault()}>
        Design
      </a>
    </nav>
  ),
}));
vi.mock('./easy-mode-return', () => ({ EasyModeReturnButton: () => null }));
vi.mock('./workspace-sidebar', () => ({ versionTranslationKey: () => 'app.version' }));
vi.mock('@/components/bridge', () => ({ appVersion: () => '1.0.0' }));
import { MobileTopBar } from './mobile-nav';

function openDrawer() {
  render(<MobileTopBar />);
  const toggle = document.querySelector<HTMLButtonElement>('[data-slot="mobile-nav-toggle"]')!;
  fireEvent.click(toggle);
  return toggle;
}

it('opens the workspace navigation as a drawer and closes it with Escape', () => {
  const toggle = openDrawer();
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByRole('navigation')).toBeInTheDocument();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

it('closes the drawer when a link inside it is followed', () => {
  openDrawer();
  fireEvent.click(screen.getByText('Design'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('keeps the drawer out of the page until it is opened', () => {
  render(<MobileTopBar />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
});
