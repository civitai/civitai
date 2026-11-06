import { describe, expect, it } from 'vitest';
import { heldImageSql, isNotHeldAnswer, playedFraction, WATCHED_FRACTION } from '../held-media';

const answer = (status: number, headers: Record<string, string> = {}) => ({
  status,
  headers: new Headers(headers),
});

describe('isNotHeldAnswer', () => {
  // The CSAM report page sends an image to the public CDN on this answer alone; a held image must
  // never get there because storage blipped.
  it('is only the 404 that says not-held', () => {
    expect(isNotHeldAnswer(answer(404, { 'x-held-media': 'not-held' }))).toBe(true);
    expect(isNotHeldAnswer(answer(404))).toBe(false);
    expect(isNotHeldAnswer(answer(502, { 'x-held-media': 'not-held' }))).toBe(false);
    for (const status of [401, 403, 415, 500, 502, 503, 204, 200])
      expect(isNotHeldAnswer(answer(status))).toBe(false);
  });
});

describe('heldImageSql', () => {
  it('refuses an alias that is not a plain identifier, since it is spliced into SQL', () => {
    expect(() => heldImageSql('i')).not.toThrow();
    expect(() => heldImageSql('i; DROP TABLE "Image"')).toThrow(/alias/);
    expect(() => heldImageSql('"i"')).toThrow(/alias/);
  });
});

describe('playedFraction', () => {
  const video = (duration: number, ranges: [number, number][]) => ({
    duration,
    played: {
      length: ranges.length,
      start: (i: number) => ranges[i][0],
      end: (i: number) => ranges[i][1],
    },
  });
  const watched = (v: ReturnType<typeof video>) => playedFraction(v) >= WATCHED_FRACTION;

  it('a tenth of a second is not watched', () => {
    expect(watched(video(100, [[0, 0.1]]))).toBe(false);
  });

  it('94% is not watched', () => {
    expect(watched(video(100, [[0, 94]]))).toBe(false);
  });

  it('seeking to the end adds nothing that did not play', () => {
    expect(
      watched(
        video(100, [
          [0, 1],
          [99, 100],
        ])
      )
    ).toBe(false);
  });

  it('counts plays across pauses together', () => {
    expect(
      watched(
        video(100, [
          [0, 40],
          [40, 70],
          [70, 95],
        ])
      )
    ).toBe(true);
  });

  it('does not count a span played twice twice', () => {
    expect(
      playedFraction(
        video(100, [
          [0, 60],
          [10, 60],
          [50, 70],
        ])
      )
    ).toBeCloseTo(0.7);
  });

  it.each([NaN, Infinity, 0])('is 0 when the duration is %s', (duration) => {
    expect(playedFraction(video(duration, [[0, 100]]))).toBe(0);
  });
});
