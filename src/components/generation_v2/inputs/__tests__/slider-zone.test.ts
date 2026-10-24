import { describe, expect, it } from 'vitest';
import { sliderZone, sliderZoneStyles } from '~/components/generation_v2/inputs/slider-zone';

describe('sliderZone', () => {
  it('places a band inside the range by its share of the range', () => {
    expect(sliderZone({ min: 0, max: 100 }, { min: 20, max: 40 })).toEqual({ start: 20, end: 40 });
  });

  // A band that leaves the range stops at the track's edge.
  it('clamps a band that leaves the range to the track', () => {
    expect(sliderZone({ min: 4, max: 60 }, { min: 2, max: 8 })).toEqual({
      start: 0,
      end: ((8 - 4) / 56) * 100,
    });
  });

  it('paints a zero-width band as a tick', () => {
    const zone = sliderZone({ min: 1, max: 10 }, { min: 1, max: 1 });
    expect(zone?.start).toBe(0);
    expect(zone?.end).toBeGreaterThan(0);
  });

  it('paints nothing without a band or on a degenerate range', () => {
    expect(sliderZone({ min: 0, max: 10 }, undefined)).toBeUndefined();
    expect(sliderZone({ min: 5, max: 5 }, { min: 1, max: 2 })).toBeUndefined();
  });
});

describe('sliderZoneStyles', () => {
  it('clears the track pseudo paint and draws the band on the track, with no fill bar', () => {
    const styles = sliderZoneStyles({ start: 20, end: 40 });
    expect(styles.track['--track-bg']).toBe('transparent');
    expect(styles.track.background).toContain('green-6) 20%');
    expect(styles.track.background).toContain('green-6) 40%');
    expect(styles.bar.background).toBe('transparent');
  });
});
