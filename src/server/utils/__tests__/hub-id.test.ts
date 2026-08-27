import { describe, expect, it } from 'vitest';
import { decodeHubId, encodeHubId } from '~/server/utils/hub-id';

/**
 * The hub's public identifier. This is obfuscation, not authorisation — every read
 * still applies `hubViewerWhere` — so what these assert is the one property it buys:
 * you cannot walk hub ids by counting.
 *
 * Note what a mocked test CANNOT cover: `HUB_ID_SALT` is read at module load, so this
 * file exercises the empty-salt alphabet, which is what dev and test run with. A
 * wrong salt in an environment shows up as every hub link there 404ing, not here.
 */
describe('hub id encoding', () => {
  it('round-trips', () => {
    for (const id of [1, 2, 19, 1000, 123456, 2_147_483_647]) {
      expect(decodeHubId(encodeHubId(id))).toBe(id);
    }
  });

  it('refuses a bare integer, which is what the pre-encoding URLs carried', () => {
    // The whole point. Accepting these back would leave enumeration exactly as open
    // as it was, and an old link 404ing is the accepted cost of that.
    for (const raw of ['1', '19', '1000', '0', '-1']) {
      expect(decodeHubId(raw)).toBeNull();
    }
  });

  it('refuses junk rather than throwing, so a bad URL is a 404 and not a 500', () => {
    for (const raw of ['', ' ', 'not-a-key', '!!!!', 'l1I0O', 'a'.repeat(200)]) {
      expect(decodeHubId(raw)).toBeNull();
    }
  });

  it('does not produce consecutive keys for consecutive ids', () => {
    // The property that makes counting useless. A codec that leaked ordering would
    // pass every test above and none of the enumeration resistance.
    const keys = [10, 11, 12, 13, 14].map(encodeHubId);
    const sorted = [...keys].sort();
    expect(keys).not.toEqual(sorted);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('pads short ids so hub 1 is not visibly hub 1', () => {
    // Without a minimum length the first hubs encode to one or two characters, which
    // is its own ordering leak.
    expect(encodeHubId(1).length).toBeGreaterThanOrEqual(8);
  });

  it('never emits characters that get mangled when a link is read aloud or copied', () => {
    const keys = [1, 42, 999, 123456, 9_999_999].map(encodeHubId);
    for (const key of keys) expect(key).toMatch(/^[a-zA-Z2-9]+$/);
    // Explicitly the confusable set the alphabet leaves out.
    for (const key of keys) expect(key).not.toMatch(/[lIO01B]/);
  });
});
