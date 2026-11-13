import { Unpackr } from 'msgpackr';
import { describe, expect, it, vi } from 'vitest';
import type * as PayloadDecode from '~/server/services/resource-intent-tags/payload-decode';
import {
  decodeTagIndex,
  decodeTagIndexData,
  encodeTagIndex,
} from '~/server/services/resource-intent-tags/payload';
import { smallTagIndexData } from './resource-intent-tags.fixture';

/**
 * A main-thread decode runs its synchronous parts (unpack, validate, assemble) with a whole
 * event-loop turn between each: a timer due when one ends fires before the next starts.
 */

const seen = vi.hoisted(() => ({ timerFired: false, firedBeforeAssemble: null as boolean | null }));
vi.mock('~/server/services/resource-intent-tags/payload-decode', async (importOriginal) => {
  const real = await importOriginal<typeof PayloadDecode>();
  return {
    ...real,
    decodeTagIndexData: async (...args: Parameters<typeof real.decodeTagIndexData>) => {
      const out = await real.decodeTagIndexData(...args);
      seen.timerFired = false;
      setTimeout(() => (seen.timerFired = true), 0);
      return out;
    },
    assembleTagIndex: (...args: Parameters<typeof real.assembleTagIndex>) => {
      seen.firedBeforeAssemble = seen.timerFired;
      return real.assembleTagIndex(...args);
    },
  };
});

describe('decodeTagIndex', () => {
  it('lets the event loop turn between validating and assembling', async () => {
    const payload = await encodeTagIndex(smallTagIndexData('c'.repeat(64)), 'd'.repeat(64));
    const { index } = await decodeTagIndex(payload);
    expect(index.kinds.addon.modelIds.length).toBeGreaterThan(0);
    expect(seen.firedBeforeAssemble).toBe(true);
  });
});

describe('decodeTagIndexData', () => {
  it('lets the event loop turn between unpacking and validating', async () => {
    const payload = await encodeTagIndex(smallTagIndexData('c'.repeat(64)), 'd'.repeat(64));
    let fired = false;
    const real = Unpackr.prototype.unpack;
    const spy = vi
      .spyOn(Unpackr.prototype, 'unpack')
      .mockImplementation(function (this: Unpackr, ...args: Parameters<Unpackr['unpack']>) {
        // Due when the unpack ends; without a turn before validating, the decode resolves first.
        if ((args[0] as Uint8Array).length > 1) setTimeout(() => (fired = true), 0);
        return real.apply(this, args);
      });
    try {
      await decodeTagIndexData(payload);
      expect(fired).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
