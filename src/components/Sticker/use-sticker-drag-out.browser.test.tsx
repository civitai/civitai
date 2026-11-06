import { beforeEach, describe, expect, test } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { LONG_PRESS_MS, useStickerDragOut } from '~/components/Sticker/use-sticker-drag-out';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';

const COSMETIC_ID = 5;

function Shelf() {
  const { grab, shelfRef } = useStickerDragOut(0.5);
  return (
    <div ref={shelfRef}>
      <button type="button" data-testid="tile" onPointerDown={grab(COSMETIC_ID)}>
        sticker
      </button>
    </div>
  );
}

let surface: HTMLDivElement;

beforeEach(() => {
  surface = document.createElement('div');
  Object.assign(surface.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '300px',
    height: '300px',
  });
  document.body.appendChild(surface);
  useStickerPlacementDraftStore.setState({
    drafts: [],
    targetImageId: 1,
    surface,
    tray: null,
    interaction: null,
  });
  return () => surface.remove();
});

const press = (type: string, pointerType: string, x: number, y: number, target: EventTarget) => {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 9,
    pointerType,
    isPrimary: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
  });
  target.dispatchEvent(event);
  return event;
};

const tile = async () => {
  await renderWithProviders(<Shelf />);
  return document.querySelector('[data-testid="tile"]') as HTMLElement;
};

const drafts = () => useStickerPlacementDraftStore.getState().drafts;

describe('picking a sticker off the shelf', () => {
  test('a mouse press is a drag straight away, landing under the cursor', async () => {
    const button = await tile();
    const down = press('pointerdown', 'mouse', 150, 400, button);
    expect(down.defaultPrevented).toBe(true);

    press('pointermove', 'mouse', 60, 90, window);
    expect(drafts()).toHaveLength(1);
    expect(drafts()[0]).toMatchObject({ cosmeticId: COSMETIC_ID, x: 0.2, y: 0.3 });
  });

  test('a tap adds the sticker where the image is in view', async () => {
    const button = await tile();
    press('pointerdown', 'touch', 150, 400, button);
    press('pointerup', 'touch', 150, 400, window);

    expect(drafts()).toHaveLength(1);
    expect(drafts()[0]).toMatchObject({ cosmeticId: COSMETIC_ID, x: 0.5, y: 0.5 });
  });

  test('a swipe adds nothing', async () => {
    const button = await tile();
    press('pointerdown', 'touch', 150, 400, button);
    press('pointermove', 'touch', 150, 340, window);
    press('pointerup', 'touch', 150, 340, window);

    expect(drafts()).toHaveLength(0);
  });

  test('a long press picks the sticker up and drags it onto the image', async () => {
    const button = await tile();
    press('pointerdown', 'touch', 150, 400, button);
    await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 50));
    press('pointermove', 'touch', 60, 90, window);

    await expect.poll(() => drafts()).toHaveLength(1);
    expect(drafts()[0]).toMatchObject({ cosmeticId: COSMETIC_ID, x: 0.2, y: 0.3 });
  });

  // `pan-y` lets the press start as a scroll candidate; once a sticker is picked
  // up, only a cancelled touchmove keeps the page from scrolling under it, and
  // that holds until the finger lifts — the same touch goes on to move the draft.
  test('the page scrolls until a sticker is picked up, then holds still until the finger lifts', async () => {
    const button = await tile();
    const scrolls = () => {
      const move = new TouchEvent('touchmove', { bubbles: true, cancelable: true });
      button.dispatchEvent(move);
      return !move.defaultPrevented;
    };
    press('pointerdown', 'touch', 150, 400, button);
    expect(scrolls()).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 50));
    await expect.poll(scrolls).toBe(false);

    press('pointermove', 'touch', 60, 90, window);
    await expect.poll(() => drafts()).toHaveLength(1);
    expect(scrolls()).toBe(false);

    window.dispatchEvent(new TouchEvent('touchend'));
    expect(scrolls()).toBe(true);
  });
});
