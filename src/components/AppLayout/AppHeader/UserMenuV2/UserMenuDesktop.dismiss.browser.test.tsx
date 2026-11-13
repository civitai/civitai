import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../../test/component-setup';

/**
 * Mantine closes the menu on the outside mousedown, and the click that follows still lands on
 * whatever is under the pointer. On the home page that is often a full-width /pricing banner.
 */
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCurrentUser: () => null,
}));
vi.mock('./useResolvedUserMenu', () => ({
  useResolvedUserMenu: () => ({ signedIn: false, events: [], pinned: [], nodes: [] }),
}));
vi.mock('~/components/AppLayout/AppHeader/UserMenu', async () => {
  const { createContext } = await import('react');
  return {
    UserMenuCtx: createContext({ handleClose: () => undefined }),
    UserMenuFooter: () => null,
    AccountSwitcher: () => null,
    BuzzBalances: () => null,
  };
});

const { UserMenuDesktop } = await import('./UserMenuDesktop');

const pins = { pins: [], mutedBadges: [], flush: () => undefined } as never;

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <UserMenuDesktop
        open={open}
        setOpen={setOpen}
        pins={pins}
        trigger={<button type="button">menu</button>}
      />
      <a href="#banner" data-testid="banner" style={{ display: 'block', height: 200 }}>
        banner
      </a>
    </div>
  );
}

let followed: number;
const onClick = (event: MouseEvent) => {
  if ((event.target as Element).closest('[data-testid="banner"]')) {
    followed++;
    event.preventDefault();
  }
};

beforeEach(() => {
  followed = 0;
  // Bubble phase on document: runs only if nothing cancelled the click on its way down.
  document.addEventListener('click', onClick);
});
afterEach(() => {
  document.removeEventListener('click', onClick);
  cleanup();
});

async function openMenu() {
  await renderWithProviders(<Harness />);
  await userEvent.click(page.getByRole('button', { name: 'menu' }));
  await expect.element(page.getByRole('menu')).toBeInTheDocument();
}

describe('UserMenuDesktop dismiss click', () => {
  it('closes on an outside click without following the link under it', async () => {
    await openMenu();

    await userEvent.click(page.getByTestId('banner'));

    await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
    expect(followed).toBe(0);
  });

  it('lets the next click through', async () => {
    await openMenu();
    await userEvent.click(page.getByTestId('banner'));

    await userEvent.click(page.getByTestId('banner'));

    expect(followed).toBe(1);
  });

  it('lets a keyboard click through after a dismissing press that ended without a click', async () => {
    await openMenu();
    const opts = { bubbles: true, isPrimary: true };
    document.body.dispatchEvent(new PointerEvent('pointerdown', opts));
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
    document.body.dispatchEvent(new PointerEvent('pointerup', opts));
    (page.getByTestId('banner').element() as HTMLElement).focus();

    await userEvent.keyboard('{Enter}');

    expect(followed).toBe(1);
  });

  it('lets the first click through after an Escape close', async () => {
    await openMenu();
    await userEvent.keyboard('{Escape}');
    await expect.element(page.getByRole('menu')).not.toBeInTheDocument();

    await userEvent.click(page.getByTestId('banner'));

    expect(followed).toBe(1);
  });
});
