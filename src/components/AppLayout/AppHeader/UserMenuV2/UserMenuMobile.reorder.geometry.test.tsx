import { IconBox } from '@tabler/icons-react';
import { createElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import {
  box,
  nextLayout,
  PHONE_VIEWPORT,
  renderAtViewport,
} from '../../../../../test/geometry-setup';
import type * as TrackUtils from '~/components/TrackView/track.utils';

/**
 * Reordering pins on a phone: a Reorder button beside the "Pinned" label turns the rows into
 * non-navigating rows with a drag handle each. Real Chromium, real Tailwind and layout at 390px;
 * the touch drag is dispatched as touch events on the handle (a real finger is not verified here).
 */
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCurrentUser: () => ({ id: 1, username: 'tester' }),
}));
vi.mock('~/components/TrackView/track.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackUtils>()),
  useTrackEvent: () => ({ trackAction: () => ({ catch: () => undefined }) }),
}));

const { UserMenuCtx } = await import('~/components/AppLayout/AppHeader/UserMenu');
const { MobilePinned } = await import('./UserMenuMobile');
const { ContainerProvider } = await import('~/components/ContainerProvider/ContainerProvider');

afterEach(cleanup);

const ITEMS = [
  { id: 'inventory' as const, label: 'Inventory', icon: IconBox, href: '/inventory' },
  { id: 'vault' as const, label: 'Vault', icon: IconBox, href: '/vault' },
  { id: 'bounties' as const, label: 'Bounties', icon: IconBox, href: '/bounties' },
];

async function renderPinned(items = ITEMS) {
  const move = vi.fn();
  const flush = vi.fn();
  const handleClose = vi.fn();
  const pins = { pins: items.map((i) => i.id), canEdit: true, toggle: vi.fn(), move, flush };
  await renderAtViewport(
    <ContainerProvider containerName="main">
      <UserMenuCtx.Provider value={{ handleClose }}>
        <div id="panel" className="flex flex-col p-1" style={{ width: PHONE_VIEWPORT.width }}>
          {createElement(MobilePinned, {
            pinned: items,
            pins: pins as never,
            onToggle: vi.fn(),
            announce: vi.fn(),
          })}
        </div>
      </UserMenuCtx.Provider>
    </ContainerProvider>,
    PHONE_VIEWPORT
  );
  return { move, flush, handleClose };
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

  test('swaps the rows for handles that do not navigate, then back on Done', async () => {
    const { flush, handleClose } = await renderPinned();
    expect(document.querySelectorAll('a[href]').length).toBe(3);
    expect(handle('Inventory')).toBeNull();

    await tap(reorderButton());
    expect(reorderButton()!.textContent).toBe('Done');
    expect(document.querySelectorAll('a[href]').length).toBe(0);
    expect(document.querySelector('[aria-label="Unpin Inventory"]')).toBeNull();
    for (const { label } of ITEMS) {
      const grip = box(handle(label)!);
      // A finger-sized target at the pin column, on screen.
      expect(grip.width).toBeGreaterThanOrEqual(34);
      expect(grip.right).toBeLessThanOrEqual(PHONE_VIEWPORT.width);
      // Without this a finger on the handle scrolls the menu instead of dragging the row.
      expect(getComputedStyle(handle(label)!).touchAction).toBe('none');
    }

    // Tapping a row's name leaves the menu and the page alone.
    await tap([...document.querySelectorAll('span, p')].find((e) => e.textContent === 'Vault'));
    expect(handleClose).not.toHaveBeenCalled();

    await tap(reorderButton());
    expect(flush).toHaveBeenCalledTimes(1);
    expect(handle('Inventory')).toBeNull();
    expect(document.querySelectorAll('a[href]').length).toBe(3);
  });

  test('drags a row by its handle with touch', async () => {
    const { move } = await renderPinned();
    await tap(reorderButton());
    const grip = handle('Inventory')!;
    const from = box(grip);
    const targetRow = box(handle('Bounties')!);
    const startY = from.top + from.height / 2;
    const endY = targetRow.top + targetRow.height / 2;

    await dragWithTouch(grip, startY, endY);

    expect(move).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledWith('inventory', 'bounties');
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
});
