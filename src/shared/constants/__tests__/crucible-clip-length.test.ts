import { describe, expect, it } from 'vitest';
import {
  CRUCIBLE_CLIP_LENGTH_TOLERANCE_SECONDS,
  CRUCIBLE_MAX_CLIP_SECONDS_OPTIONS,
  clipDisplaySeconds,
  clipLengthAllowed,
} from '~/shared/constants/crucible.constants';
import { formatDuration } from '~/utils/number-helpers';

// The 0.5s tolerance is a product decision from the Crucible contests owner (2026-11): a 30s video
// made on Civitai measures 30.016-30.418s from container padding. Shrinking it below that makes
// on-site clips fail a limit of their own length again.
describe('clipLengthAllowed', () => {
  it('accepts an on-site 30s clip against a 30s limit', () => {
    expect(clipLengthAllowed(30.023, 30)).toBe(true);
    expect(clipLengthAllowed(30.418, 30)).toBe(true);
  });

  it('accepts exactly the limit plus the tolerance', () => {
    expect(clipLengthAllowed(30 + CRUCIBLE_CLIP_LENGTH_TOLERANCE_SECONDS, 30)).toBe(true);
  });

  it('rejects just over the limit plus the tolerance', () => {
    expect(clipLengthAllowed(30 + CRUCIBLE_CLIP_LENGTH_TOLERANCE_SECONDS + 0.001, 30)).toBe(false);
    expect(clipLengthAllowed(31, 30)).toBe(false);
  });

  it('accepts anything when there is no limit or no recorded duration', () => {
    expect(clipLengthAllowed(999, null)).toBe(true);
    expect(clipLengthAllowed(null, 30)).toBe(true);
  });
});

describe('clipDisplaySeconds', () => {
  it('shows an allowed clip inside the tolerance as the limit, not over it', () => {
    expect(formatDuration(clipDisplaySeconds(30.5, 30))).toBe('00:30');
  });

  // formatDuration rounds seconds without carrying into minutes, so a fraction here printed "00:60".
  it('shows an allowed clip just under a minute limit as the limit', () => {
    expect(formatDuration(clipDisplaySeconds(59.6, 60))).toBe('1:00');
  });

  it('shows a rejected clip as longer than the limit', () => {
    expect(formatDuration(clipDisplaySeconds(30.501, 30))).toBe('00:31');
  });

  // The rendered length is what the entrant compares against "max 0:30": an accepted clip must
  // never read as over the limit, and a rejected one never as equal to it.
  it('never contradicts the verdict for any limit', () => {
    const asShown = (seconds: number) => {
      const text = formatDuration(seconds);
      const [m, s] = text.split(':').map(Number);
      expect(s, `${seconds}s shown as ${text}`).toBeLessThan(60);
      return m * 60 + s;
    };
    for (const max of CRUCIBLE_MAX_CLIP_SECONDS_OPTIONS) {
      for (let ms = (max - 2) * 1000; ms <= (max + 2) * 1000; ms += 1) {
        const duration = ms / 1000;
        const shown = asShown(clipDisplaySeconds(duration, max));
        if (clipLengthAllowed(duration, max))
          expect(shown, `${duration}s`).toBeLessThanOrEqual(max);
        else expect(shown, `${duration}s`).toBeGreaterThan(max);
      }
    }
  });
});
