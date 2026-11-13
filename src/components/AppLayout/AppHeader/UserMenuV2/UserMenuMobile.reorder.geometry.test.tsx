import { IconBox } from '@tabler/icons-react';
import { createElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
import {
  box,
  nextLayout,
  PHONE_VIEWPORT,
  renderAtViewport,
} from '../../../../../test/geometry-setup';
import type * as UserMenu from '~/components/AppLayout/AppHeader/UserMenu';
import type * as TrackUtils from '~/components/TrackView/track.utils';

/**
 * Reordering pins on a phone: a Reorder button beside the "Pinned" label turns the rows into
 * non-navigating rows with a drag handle each. Real Chromium, real Tailwind and layout at 390px;
 * the touch drag is dispatched as touch events on the handle (a real finger is not verified here).
 */
const mocks = vi.hoisted(() => ({ pinned: [] as unknown[] }));

// Signed out of the header rows, so the sheet's own key handling is what runs around the pins.
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCurrentUser: () => null,
}));
vi.mock('~/components/AppLayout/AppHeader/UserMenu', async (importOriginal) => ({
  ...(await importOriginal<typeof UserMenu>()),
  UserMenuFooter: () => null,
}));
vi.mock('./useResolvedUserMenu', () => ({
  useResolvedUserMenu: () => ({ signedIn: true, events: [], pinned: mocks.pinned, nodes: [] }),
}));
vi.mock('~/components/TrackView/track.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackUtils>()),
  useTrackEvent: () => ({ trackAction: () => ({ catch: () => undefined }) }),
}));

const { UserMenuCtx } = await import('~/components/AppLayout/AppHeader/UserMenu');
const { MobilePinned, UserMenuMobile } = await import('./UserMenuMobile');
const { ContainerProvider } = await import('~/components/ContainerProvider/ContainerProvider');

afterEach(cleanup);

const ITEMS = [
  { id: 'inventory' as const, label: 'Inventory', icon: IconBox, href: '/inventory' },
  { id: 'vault' as const, label: 'Vault', icon: IconBox, href: '/vault' },
  { id: 'bounties' as const, label: 'Bounties', icon: IconBox, href: '/bounties' },
  // No link: a row that runs an action, so tapping it is what closes the menu.
  { id: 'getting-started' as const, label: 'Help', icon: IconBox, onClick: vi.fn() },
];

async function renderPinned(
  items = ITEMS,
  { toggle = true, canEdit = true }: { toggle?: boolean; canEdit?: boolean } = {}
) {
  const announce = vi.fn();
  const move = vi.fn();
  const flush = vi.fn();
  const handleClose = vi.fn();
  const pins = { pins: items.map((i) => i.id), canEdit, toggle: vi.fn(), move, flush };
  await renderAtViewport(
    <ContainerProvider containerName="main">
      <UserMenuCtx.Provider value={{ handleClose }}>
        <div id="panel" className="flex flex-col p-1" style={{ width: PHONE_VIEWPORT.width }}>
          {createElement(MobilePinned, {
            pinned: items,
            pins: pins as never,
            onToggle: toggle ? vi.fn() : undefined,
            announce,
          })}
        </div>
      </UserMenuCtx.Provider>
    </ContainerProvider>,
    PHONE_VIEWPORT
  );
  return { move, flush, handleClose, announce };
}

const reorderButton = () =>
  [...document.querySelectorAll('button')].find((b) =>
    ['Reorder', 'Done'].includes(b.textContent ?? '')
  );
const handle = (label: string) =>
  document.querySelector<HTMLElement>(`[aria-label="Reorder ${label}"]`);

async function tap(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to tap');
  (el as HTMLElement).click();
  await nextLayout();
}

function touch(target: Element, type: string, y: number) {
  const x = target.getBoundingClientRect().left + 10;
  const point = new Touch({ identifier: 1, target, clientX: x, clientY: y });
  target.dispatchEvent(
    new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: type === 'touchend' ? [] : [point],
      targetTouches: type === 'touchend' ? [] : [point],
      changedTouches: [point],
    })
  );
}

/** Two moves: dnd-kit starts the drag on the move that passes its distance, and tracks from the next. */
async function dragWithTouch(target: Element, startY: number, endY: number) {
  touch(target, 'touchstart', startY);
  await nextLayout();
  touch(target, 'touchmove', startY + 8);
  await nextLayout();
  touch(target, 'touchmove', endY);
  await nextLayout();
  touch(target, 'touchend', endY);
  await nextLayout();
}

describe('pin reorder mode on a phone', () => {
  test('puts Reorder on the Pinned label line, in the column where the pin icons sit', async () => {
    await renderPinned();
    const button = reorderButton()!;
    expect(button.textContent).toBe('Reorder');
    const label = [...document.querySelectorAll('p, div')].find((e) => e.textContent === 'Pinned')!;
    const pinIcon = document.querySelector('[aria-label="Unpin Inventory"]')!;

    expect(
      Math.abs(box(button).top + box(button).height / 2 - (box(label).top + box(label).height / 2))
    ).toBeLessThanOrEqual(1);
    // Right-aligned with the pin column and a finger-sized target.
    expect(box(button).right).toBeLessThanOrEqual(box(pinIcon).right);
    expect(box(pinIcon).right - box(button).right).toBeLessThanOrEqual(2);
    expect(box(button).height).toBeGreaterThanOrEqual(32);
    expect(box(button).left).toBeGreaterThan(box(label).right);
  });

  test('offers no Reorder for a single pin', async () => {
    await renderPinned(ITEMS.slice(0, 1));
    expect(reorderButton()).toBeUndefined();
  });

  test('offers no Reorder while edits are refused', async () => {
    await renderPinned(ITEMS, { canEdit: false });
    expect(reorderButton()).toBeUndefined();
  });

  test('offers no Reorder to a viewer who cannot pin', async () => {
    await renderPinned(ITEMS, { toggle: false });
    expect(reorderButton()).toBeUndefined();
  });

  test('swaps the rows for handles that do not navigate, then back on Done', async () => {
    const { flush, handleClose } = await renderPinned();
    expect(document.querySelectorAll('a[href]').length).toBe(3);
    expect(handle('Inventory')).toBeNull();
    const pinColumn = box(document.querySelector('[aria-label="Unpin Inventory"]')!).right;

    // A row that runs an action closes the menu when tapped: the control for the reorder-mode tap below.
    await tap([...document.querySelectorAll('span, p')].find((e) => e.textContent === 'Help'));
    expect(handleClose).toHaveBeenCalledTimes(1);
    handleClose.mockClear();

    await tap(reorderButton());
    expect(reorderButton()!.textContent).toBe('Done');
    expect(document.querySelectorAll('a[href]').length).toBe(0);
    expect(document.querySelector('[aria-label="Unpin Inventory"]')).toBeNull();
    for (const { label } of ITEMS) {
      const grip = box(handle(label)!);
      // A finger-sized target at the pin column, on screen.
      expect(grip.width).toBeGreaterThanOrEqual(34);
      // In the column the pin icons sat in, so the rows do not jump when the mode toggles.
      expect(Math.abs(grip.right - pinColumn)).toBeLessThanOrEqual(2);
      // Without this a finger on the handle scrolls the menu instead of dragging the row.
      expect(getComputedStyle(handle(label)!).touchAction).toBe('none');
    }

    // Tapping a row's name leaves the menu and the page alone.
    await tap([...document.querySelectorAll('span, p')].find((e) => e.textContent === 'Vault'));
    await tap([...document.querySelectorAll('span, p')].find((e) => e.textContent === 'Help'));
    expect(handleClose).not.toHaveBeenCalled();

    await tap(reorderButton());
    expect(flush).toHaveBeenCalledTimes(1);
    expect(handle('Inventory')).toBeNull();
    expect(document.querySelectorAll('a[href]').length).toBe(3);
  });

  test('drags a row by its handle with touch', async () => {
    const { move, announce } = await renderPinned();
    await tap(reorderButton());
    const grip = handle('Inventory')!;
    const from = box(grip);
    const targetRow = box(handle('Bounties')!);
    const startY = from.top + from.height / 2;
    const endY = targetRow.top + targetRow.height / 2;

    await dragWithTouch(grip, startY, endY);

    expect(move).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledWith('inventory', 'bounties');
    expect(announce).toHaveBeenCalledWith('Moved Inventory');
  });

  test('a touch on the row itself, not the handle, does not drag', async () => {
    const { move } = await renderPinned();
    await tap(reorderButton());
    const row = [...document.querySelectorAll('span, p')].find(
      (e) => e.textContent === 'Inventory'
    )!;
    const third = box(handle('Bounties')!);
    // The same gesture as the handle drag above, which moves the row to the third place.
    await dragWithTouch(row, box(row).top + 4, third.top + third.height / 2);

    expect(move).not.toHaveBeenCalled();
  });

  test('drags a row by its handle with the keyboard', async () => {
    const { move } = await renderPinned();
    await tap(reorderButton());
    handle('Inventory')!.focus();

    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');
    await nextLayout();

    expect(move).toHaveBeenCalledWith('inventory', 'bounties');
  });

  test('leaves Enter on a pinned row to the row until the mode is on', async () => {
    const { move } = await renderPinned();
    const link = document.querySelector<HTMLElement>('a[href="/inventory"]')!;
    link.addEventListener('click', (event) => event.preventDefault());
    link.focus();

    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');
    await nextLayout();

    // A keyboard drag would have started, moved and dropped; the row only got its Enter.
    expect(move).not.toHaveBeenCalled();
  });
});

describe('Escape while reordering', () => {
  async function renderSheet() {
    mocks.pinned = ITEMS;
    const setOpen = vi.fn();
    const move = vi.fn();
    const pins = {
      pins: ITEMS.map((i) => i.id),
      canEdit: true,
      toggle: vi.fn(),
      move,
      flush: vi.fn(),
      mutedBadges: [],
    };
    await renderAtViewport(
      <ContainerProvider containerName="main">
        <UserMenuMobile
          open
          setOpen={setOpen}
          pins={pins as never}
          trigger={<button>menu</button>}
        />
      </ContainerProvider>,
      PHONE_VIEWPORT
    );
    await tap(reorderButton());
    return { setOpen, move };
  }

  test('cancels a keyboard drag first, and closes the sheet only when nothing is held', async () => {
    const { setOpen, move } = await renderSheet();
    const grip = handle('Inventory')!;
    grip.focus();

    await userEvent.keyboard('{Enter}');
    await nextLayout();
    expect(grip.getAttribute('aria-pressed')).toBe('true');
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Escape}');
    await nextLayout();

    expect(grip.getAttribute('aria-pressed')).not.toBe('true');
    expect(setOpen).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();

    // The same key with nothing held closes the sheet: the control that Escape is wired here at all.
    await userEvent.keyboard('{Escape}');
    expect(setOpen).toHaveBeenCalledWith(false);
  });
});
