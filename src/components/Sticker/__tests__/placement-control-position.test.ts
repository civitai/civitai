import { describe, expect, it } from 'vitest';
import { placementControlPosition } from '~/components/Sticker/placement-control-position';

/**
 * The measurements this exists because of, taken from the running page with a
 * pending placement at each edge: the media box was 658 x 986 and the
 * approve/decline pair 122 x 22. A sticker at `y = 0.95` put both buttons 59px
 * BELOW the box; `x = 0.03` and `x = 0.97` put one button 42px past the side.
 * Three edges out of four, all of them clipped away by the layer's
 * `overflow-hidden`.
 */
const BOX = { width: 658, height: 986 };
const CONTROL = { width: 122, height: 22 };
const GAP = 14;
const STICKER = 80;

const at = (
  x: number,
  y: number,
  overrides: Partial<Parameters<typeof placementControlPosition>[0]> = {}
) =>
  placementControlPosition({
    x,
    y,
    stickerHeight: STICKER,
    gap: GAP,
    control: CONTROL,
    box: BOX,
    ...overrides,
  });

const inside = (position: { left: number; top: number } | null) => {
  expect(position).not.toBeNull();
  if (!position) return;
  expect(position.left).toBeGreaterThanOrEqual(0);
  expect(position.top).toBeGreaterThanOrEqual(0);
  expect(position.left + CONTROL.width).toBeLessThanOrEqual(BOX.width);
  expect(position.top + CONTROL.height).toBeLessThanOrEqual(BOX.height);
};

describe('placementControlPosition', () => {
  it('keeps the controls below the sticker when there is room', () => {
    const position = at(0.5, 0.05);

    // The preferred side, and the one the controls have always been on: below
    // the artwork, clear of the thing being judged.
    expect(position?.top).toBe(0.05 * BOX.height + STICKER / 2 + GAP);
    inside(position);
  });

  it('flips above the sticker when below would leave the box', () => {
    // The reported bug. Unclamped this was 996, which is 59px past the bottom
    // edge and entirely clipped.
    const position = at(0.5, 0.95);

    expect(position?.top).toBe(0.95 * BOX.height - STICKER / 2 - GAP - CONTROL.height);
    expect(position?.top).toBeLessThan(0.95 * BOX.height);
    inside(position);
  });

  it('clamps into the left edge', () => {
    // Unclamped: 0.03 * 658 - 61 = -41, i.e. 41px outside.
    const position = at(0.03, 0.5);

    expect(position?.left).toBe(0);
    inside(position);
  });

  it('clamps into the right edge', () => {
    // Unclamped: 0.97 * 658 - 61 = 577, and 577 + 122 = 699 against a 658 box.
    const position = at(0.97, 0.5);

    expect(position?.left).toBe(BOX.width - CONTROL.width);
    inside(position);
  });

  it('centres on the sticker when nothing is in the way', () => {
    // The clamp must not move a control that fits — a clamp that always fires is
    // indistinguishable from one that never does, and both pass an
    // is-it-inside-the-box assertion.
    const position = at(0.5, 0.5);

    expect(position?.left).toBe(0.5 * BOX.width - CONTROL.width / 2);
  });

  it('stays inside when neither side has room', () => {
    // A sticker scaled to most of a short box. Clamping is the only honest
    // answer here: the controls end up over the artwork, which is worse-looking
    // and better than unreachable.
    const position = placementControlPosition({
      x: 0.5,
      y: 0.5,
      stickerHeight: 300,
      gap: GAP,
      control: CONTROL,
      box: { width: 300, height: 120 },
    });

    expect(position).not.toBeNull();
    expect(position?.top).toBeGreaterThanOrEqual(0);
    expect((position?.top ?? 0) + CONTROL.height).toBeLessThanOrEqual(120);
  });

  it('returns null until the control has been measured', () => {
    // Not a guess at 0,0: the caller keeps its unclamped position, so the
    // controls arrive in the right place slightly late rather than jumping.
    expect(at(0.5, 0.5, { control: { width: 0, height: 0 } })).toBeNull();
  });

  it('returns null until the box has been measured', () => {
    expect(at(0.5, 0.5, { box: { width: 0, height: 0 } })).toBeNull();
  });

  it('lands the control top-left when it is larger than the box', () => {
    // Only reachable on a thumbnail. A max/min in the wrong order returns a
    // negative coordinate here, which is the unreachable state again.
    const position = placementControlPosition({
      x: 0.5,
      y: 0.5,
      stickerHeight: 10,
      gap: GAP,
      control: { width: 400, height: 200 },
      box: { width: 100, height: 100 },
    });

    expect(position).toEqual({ left: 0, top: 0 });
  });
});
