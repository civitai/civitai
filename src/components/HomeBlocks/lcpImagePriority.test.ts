import { describe, expect, it } from 'vitest';
import {
  LCP_PRIORITY_ITEM_COUNT,
  shouldPrioritizeLcpImage,
} from '~/components/HomeBlocks/lcpImagePriority';

// Deterministic gate for LCP-image prioritisation. This is the exact decision the
// home blocks make per card: flag ON + first (top) block + one of the first N
// items. Everything else must be false so below-the-fold / later-block images are
// never marked high priority (priority on everything = priority on nothing), and
// flag-OFF is always false (byte-identical render).
describe('shouldPrioritizeLcpImage', () => {
  it('prioritizes the first N items of the first block when enabled', () => {
    for (let index = 0; index < LCP_PRIORITY_ITEM_COUNT; index++) {
      expect(shouldPrioritizeLcpImage({ enabled: true, isFirstBlock: true, index })).toBe(true);
    }
  });

  it('does NOT prioritize items at or beyond the count (below the fold)', () => {
    expect(
      shouldPrioritizeLcpImage({ enabled: true, isFirstBlock: true, index: LCP_PRIORITY_ITEM_COUNT })
    ).toBe(false);
    expect(shouldPrioritizeLcpImage({ enabled: true, isFirstBlock: true, index: 50 })).toBe(false);
  });

  it('does NOT prioritize any item in a non-first block', () => {
    expect(shouldPrioritizeLcpImage({ enabled: true, isFirstBlock: false, index: 0 })).toBe(false);
  });

  it('is always false when the flag is disabled (byte-identical render)', () => {
    expect(shouldPrioritizeLcpImage({ enabled: false, isFirstBlock: true, index: 0 })).toBe(false);
  });

  it('rejects negative indices defensively', () => {
    expect(shouldPrioritizeLcpImage({ enabled: true, isFirstBlock: true, index: -1 })).toBe(false);
  });

  it('honors a custom count', () => {
    expect(
      shouldPrioritizeLcpImage({ enabled: true, isFirstBlock: true, index: 0, count: 1 })
    ).toBe(true);
    expect(
      shouldPrioritizeLcpImage({ enabled: true, isFirstBlock: true, index: 1, count: 1 })
    ).toBe(false);
  });
});
