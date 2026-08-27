import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';
import {
  remixMenuZIndex,
  tourClickThroughZIndex,
  tourOverlayZIndex,
  tourTooltipZIndexOffset,
} from '~/shared/constants/app-layout.constants';

/**
 * `react-joyride` draws its step tooltip above its overlay by a hardcoded
 * amount that no public API reports, so `tourTooltipZIndexOffset` mirrors a
 * number from inside the package. These read the installed build so a version
 * bump that moves the tooltip layer fails here rather than in a tour.
 */
function joyrideFloaterOffsets() {
  const entry = createRequire(import.meta.url).resolve('react-joyride');
  const source = readFileSync(entry, 'utf-8');
  return [...source.matchAll(/zIndex:\s*options\.zIndex\s*\+\s*(\d+)/g)].map((m) => Number(m[1]));
}

describe('tour click-through z-index', () => {
  it('mirrors the offset react-joyride actually applies to its tooltip', () => {
    expect(joyrideFloaterOffsets()).toEqual([tourTooltipZIndexOffset]);
  });

  it('clears the tooltip, not just the overlay', () => {
    // The bug this pins: at `tourOverlayZIndex + 1` the remix menu cleared the
    // click-swallowing overlay but opened *under* the tooltip, so a step with
    // `hideFooter` had no reachable way forward.
    expect(tourClickThroughZIndex).toBeGreaterThan(tourOverlayZIndex + tourTooltipZIndexOffset);
  });

  it('leaves the menu below the tour layers when no tour is running', () => {
    expect(remixMenuZIndex).toBeLessThan(tourOverlayZIndex);
  });
});
