import { describe, expect, it } from 'vitest';
import {
  CHROME_BAR_PX,
  DEFAULT_IFRAME_MIN_HEIGHT,
  computeSlotReservation,
} from '../slotReservation';
import type { ReservableInstall } from '../slotReservation';

/**
 * Pure unit tests for the server-seeded slot-reservation math that fixes the
 * App Block CLS bug. The companion BlockSlotClient placeholder-vs-null branch
 * (a .tsx DOM case) isn't covered here because vitest includes `*.test.ts`
 * only (node env, no jsdom) — see the same note in sortInstallsForSlot.test.
 * Instead we cover the decision the client makes EXHAUSTIVELY in pure-TS
 * land: BlockSlotClient renders the reserved placeholder iff
 * `reservation.reservedHeight > 0`, else nothing. So the two cases below —
 * `reservedHeight > 0` (one/more iframe installs) and `reservedHeight === 0`
 * (zero installs, the no-regression case) — ARE the client's branch.
 */

function iframeInstall(
  minHeight: number | undefined,
  renderMode: 'iframe' | 'inline' = 'iframe'
): ReservableInstall {
  return {
    renderMode,
    manifest: {
      iframe:
        minHeight === undefined
          ? undefined
          : {
              src: 'https://block.example/app',
              minHeight,
              maxHeight: null,
              resizable: true,
              sandbox: 'allow-scripts',
            },
    },
  };
}

describe('CHROME_BAR_PX', () => {
  // Pin the derived value so a silent drift in IframeHost's AppBlockChrome
  // (py / ActionIcon size / border) is caught here. 26 (ActionIcon sm) + 8
  // (py={4} ×2) + 1 (border) = 35.
  it('is 35px (ActionIcon sm 26 + py=4 ×2 = 8 + 1px border)', () => {
    expect(CHROME_BAR_PX).toBe(35);
  });
});

describe('computeSlotReservation', () => {
  it('returns {hasInstall:false, reservedHeight:0} for a model with no install', () => {
    // The zero-install no-regression case: the slot must reserve NOTHING so
    // the sidebar Stack has no dead gap row. BlockSlotClient maps this to
    // `return null` during loading.
    expect(computeSlotReservation([])).toEqual({
      hasInstall: false,
      reservedHeight: 0,
    });
  });

  it('reserves max(minHeight)+CHROME_BAR_PX for a single iframe install', () => {
    const r = computeSlotReservation([iframeInstall(300)]);
    expect(r).toEqual({ hasInstall: true, reservedHeight: 300 + CHROME_BAR_PX });
    expect(r.reservedHeight).toBe(335);
  });

  it('reserves the TALLEST minHeight across multiple installs (+ one chrome bar)', () => {
    // Up to MAX_BLOCKS_PER_SLOT installs stack in the slot; reserve for the
    // tallest declared minHeight so none under-reserves. Only ONE chrome bar
    // is added (the reservation is a single slot-level box, not per-install).
    const r = computeSlotReservation([
      iframeInstall(200),
      iframeInstall(480),
      iframeInstall(360),
    ]);
    expect(r).toEqual({ hasInstall: true, reservedHeight: 480 + CHROME_BAR_PX });
  });

  it('falls back to DEFAULT_IFRAME_MIN_HEIGHT when an install omits minHeight', () => {
    const r = computeSlotReservation([iframeInstall(undefined)]);
    expect(r).toEqual({
      hasInstall: true,
      reservedHeight: DEFAULT_IFRAME_MIN_HEIGHT + CHROME_BAR_PX,
    });
  });

  it('treats a non-positive minHeight as the default (defensive)', () => {
    const r = computeSlotReservation([iframeInstall(0)]);
    expect(r.reservedHeight).toBe(DEFAULT_IFRAME_MIN_HEIGHT + CHROME_BAR_PX);
  });

  it('reports hasInstall:true but reservedHeight:0 for an inline-only slot', () => {
    // Inline blocks lay out in-flow and size themselves; no iframe reserve.
    // BlockSlotClient maps reservedHeight:0 to `return null` during loading —
    // correct, since inline content needs no up-front box.
    const r = computeSlotReservation([iframeInstall(300, 'inline')]);
    expect(r).toEqual({ hasInstall: true, reservedHeight: 0 });
  });

  it('reserves for the iframe install when iframe + inline installs are mixed', () => {
    const r = computeSlotReservation([
      iframeInstall(300, 'inline'),
      iframeInstall(420, 'iframe'),
    ]);
    expect(r).toEqual({ hasInstall: true, reservedHeight: 420 + CHROME_BAR_PX });
  });
});
