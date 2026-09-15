import { describe, expect, it } from 'vitest';
import {
  CRUCIBLE_PLAYBACK_SAMPLE_CEILING_MS,
  accumulatePlaybackMs,
} from '~/shared/constants/crucible.constants';

/**
 * What the judging UI counts as "watched". The gate above it is a comparison; this is the part
 * that decides whether a judge who scrubbed to the end has watched anything.
 */
describe('accumulatePlaybackMs', () => {
  it('adds the gap between two consecutive samples', () => {
    expect(accumulatePlaybackMs({ watchedMs: 0, previousTime: 1, currentTime: 1.25 })).toBe(250);
  });

  it('accumulates across samples', () => {
    const first = accumulatePlaybackMs({ watchedMs: 0, previousTime: 0, currentTime: 0.25 });
    const second = accumulatePlaybackMs({
      watchedMs: first,
      previousTime: 0.25,
      currentTime: 0.5,
    });

    expect(second).toBe(500);
  });

  it('counts nothing for the first sample of a clip, which only sets the baseline', () => {
    expect(accumulatePlaybackMs({ watchedMs: 0, previousTime: null, currentTime: 30 })).toBe(0);
  });

  it('counts nothing for a seek to the end', () => {
    // The whole point of the minimum: dragging the scrubber must not satisfy it.
    expect(accumulatePlaybackMs({ watchedMs: 0, previousTime: 0, currentTime: 120 })).toBe(0);
  });

  it('counts nothing for a scrub backwards', () => {
    expect(accumulatePlaybackMs({ watchedMs: 500, previousTime: 10, currentTime: 2 })).toBe(500);
  });

  it('counts nothing for a repeated sample at the same position', () => {
    expect(accumulatePlaybackMs({ watchedMs: 500, previousTime: 4, currentTime: 4 })).toBe(500);
  });

  it('counts a gap exactly at the ceiling, and nothing past it', () => {
    const ceilingSeconds = CRUCIBLE_PLAYBACK_SAMPLE_CEILING_MS / 1000;

    expect(
      accumulatePlaybackMs({ watchedMs: 0, previousTime: 0, currentTime: ceilingSeconds })
    ).toBe(CRUCIBLE_PLAYBACK_SAMPLE_CEILING_MS);
    expect(
      accumulatePlaybackMs({ watchedMs: 0, previousTime: 0, currentTime: ceilingSeconds + 0.001 })
    ).toBe(0);
  });

  it('needs real playback to reach a six second minimum, not one jump', () => {
    // A judge who scrubs cannot clear the bar; one who watches can. Both directions, because a
    // ceiling low enough to block the scrub could also block ordinary playback.
    const scrubbed = accumulatePlaybackMs({ watchedMs: 0, previousTime: 0, currentTime: 6 });
    expect(scrubbed).toBeLessThan(6000);

    let watched = 0;
    for (let i = 0; i < 24; i++) {
      watched = accumulatePlaybackMs({
        watchedMs: watched,
        previousTime: i * 0.25,
        currentTime: (i + 1) * 0.25,
      });
    }
    expect(watched).toBe(6000);
  });
});
