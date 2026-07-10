import { describe, expect, it, vi } from 'vitest';
import {
  emitFeedNoImagesDrop,
  FEED_DROP_DEFAULT_SAMPLE_RATE,
  FEED_NOIMAGES_DROP_EVENT,
} from '~/utils/faro/feedDrop';

/**
 * Unit tests for the silent browsing-level feed-drop telemetry (`emitFeedNoImagesDrop`).
 * The counting integration (that the `case 'models'` filter feeds it the right aggregate) is
 * covered in `useApplyHiddenPreferences.test.ts`; this covers the emit/sampling/shape contract.
 */

describe('emitFeedNoImagesDrop', () => {
  it('emits ONE event with the aggregate shape when a model was dropped', () => {
    const pushEvent = vi.fn();
    emitFeedNoImagesDrop(
      { droppedNoImages: 3, total: 20, browsingLevel: 1 },
      { pushEvent, sampleRate: 1 } // sampleRate 1 → deterministic (no RNG gate)
    );
    expect(pushEvent).toHaveBeenCalledTimes(1);
    expect(pushEvent).toHaveBeenCalledWith(FEED_NOIMAGES_DROP_EVENT, {
      droppedNoImages: '3',
      total: '20',
      browsingLevel: '1',
      sampleRate: '1',
    });
  });

  it('is SILENT when nothing was dropped (droppedNoImages === 0)', () => {
    const pushEvent = vi.fn();
    emitFeedNoImagesDrop(
      { droppedNoImages: 0, total: 20, browsingLevel: 1 },
      { pushEvent, sampleRate: 1 }
    );
    expect(pushEvent).not.toHaveBeenCalled();
  });

  it('is SILENT for a negative/absent drop count', () => {
    const pushEvent = vi.fn();
    emitFeedNoImagesDrop(
      { droppedNoImages: -1, total: 20, browsingLevel: 1 },
      { pushEvent, sampleRate: 1 }
    );
    expect(pushEvent).not.toHaveBeenCalled();
  });

  it('honours the sample-rate gate: emits when RNG < rate, drops when RNG >= rate', () => {
    const dropped = vi.fn();
    emitFeedNoImagesDrop(
      { droppedNoImages: 1, total: 10, browsingLevel: 1 },
      { pushEvent: dropped, sampleRate: 0.05, random: () => 0.9 } // 0.9 >= 0.05 → drop
    );
    expect(dropped).not.toHaveBeenCalled();

    const kept = vi.fn();
    emitFeedNoImagesDrop(
      { droppedNoImages: 1, total: 10, browsingLevel: 1 },
      { pushEvent: kept, sampleRate: 0.05, random: () => 0.0 } // 0.0 < 0.05 → emit
    );
    expect(kept).toHaveBeenCalledTimes(1);
    expect(kept).toHaveBeenCalledWith(
      FEED_NOIMAGES_DROP_EVENT,
      expect.objectContaining({ sampleRate: '0.05' })
    );
  });

  it('includes `surface` when provided and omits it otherwise', () => {
    const withSurface = vi.fn();
    emitFeedNoImagesDrop(
      { droppedNoImages: 2, total: 5, browsingLevel: 3, surface: 'home-block' },
      { pushEvent: withSurface, sampleRate: 1 }
    );
    expect(withSurface).toHaveBeenCalledWith(
      FEED_NOIMAGES_DROP_EVENT,
      expect.objectContaining({ surface: 'home-block' })
    );

    const noSurface = vi.fn();
    emitFeedNoImagesDrop(
      { droppedNoImages: 2, total: 5, browsingLevel: 3 },
      { pushEvent: noSurface, sampleRate: 1 }
    );
    expect(noSurface.mock.calls[0][1]).not.toHaveProperty('surface');
  });

  it('never throws if the telemetry sink throws (best-effort)', () => {
    const pushEvent = vi.fn(() => {
      throw new Error('faro down');
    });
    expect(() =>
      emitFeedNoImagesDrop(
        { droppedNoImages: 1, total: 10, browsingLevel: 1 },
        { pushEvent, sampleRate: 1 }
      )
    ).not.toThrow();
  });

  it('exposes a default sample rate matching the resource_timing precedent', () => {
    expect(FEED_DROP_DEFAULT_SAMPLE_RATE).toBe(0.05);
  });
});
