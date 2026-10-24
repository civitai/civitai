import { describe, expect, it } from 'vitest';
import { heldImageSql, isNotHeldAnswer } from '../held-media';

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
