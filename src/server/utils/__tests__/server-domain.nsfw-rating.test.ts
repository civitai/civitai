import { describe, expect, it, vi } from 'vitest';

/**
 * NSFW-APP-RED-ONLY helper tests — `isMatureContentRating` + `ratingAllowedOnHost`
 * (src/server/utils/server-domain.ts).
 *
 * server-domain.ts builds `serverDomainMap` from the validated server env AT
 * IMPORT, so we stub `~/env/server` with a realistic multi-color config that
 * mirrors production: civitai.red is configured as BOTH a blue and a red domain
 * (the exact shape that makes `getRequestDomainColor('civitai.red')` return
 * `blue` while `isHostForColor('civitai.red', 'red')` returns true). The host
 * gate must key off RED capability, not the color walk.
 */
vi.mock('~/env/server', () => ({
  env: {
    SERVER_DOMAIN_GREEN: 'civitai.green',
    SERVER_DOMAIN_GREEN_ALIASES: '',
    // blue's primary is civitai.com, and civitai.red is also a blue alias — this
    // is what makes the color-walk return blue for .red.
    SERVER_DOMAIN_BLUE: 'civitai.com',
    SERVER_DOMAIN_BLUE_ALIASES: 'civitai.red',
    SERVER_DOMAIN_RED: 'civitai.red',
    SERVER_DOMAIN_RED_ALIASES: 'www.civitai.red',
  },
}));

const RED_HOST = 'civitai.red';
const RED_ALIAS = 'www.civitai.red';
const COM_HOST = 'civitai.com';
const GREEN_HOST = 'civitai.green';

describe('isMatureContentRating', () => {
  it('returns true for r and x (case-insensitive)', async () => {
    const { isMatureContentRating } = await import('../server-domain');
    expect(isMatureContentRating('r')).toBe(true);
    expect(isMatureContentRating('x')).toBe(true);
    expect(isMatureContentRating('R')).toBe(true);
    expect(isMatureContentRating('X')).toBe(true);
  });

  it('returns false for SFW ratings g/pg/pg13', async () => {
    const { isMatureContentRating } = await import('../server-domain');
    expect(isMatureContentRating('g')).toBe(false);
    expect(isMatureContentRating('pg')).toBe(false);
    expect(isMatureContentRating('pg13')).toBe(false);
  });

  it('fail-closed-to-SFW for unknown/missing/null/empty (treated as not mature)', async () => {
    const { isMatureContentRating } = await import('../server-domain');
    expect(isMatureContentRating(null)).toBe(false);
    expect(isMatureContentRating(undefined)).toBe(false);
    expect(isMatureContentRating('')).toBe(false);
    expect(isMatureContentRating('mature')).toBe(false);
    expect(isMatureContentRating('nc17')).toBe(false);
  });
});

describe('ratingAllowedOnHost', () => {
  it('mature (r/x) requires a red-capable host', async () => {
    const { ratingAllowedOnHost } = await import('../server-domain');
    // red primary + red alias: allowed
    expect(ratingAllowedOnHost('r', RED_HOST)).toBe(true);
    expect(ratingAllowedOnHost('x', RED_HOST)).toBe(true);
    expect(ratingAllowedOnHost('x', RED_ALIAS)).toBe(true);
    // non-red hosts (incl. civitai.com which resolves to BLUE via the color
    // walk): NOT allowed
    expect(ratingAllowedOnHost('r', COM_HOST)).toBe(false);
    expect(ratingAllowedOnHost('x', COM_HOST)).toBe(false);
    expect(ratingAllowedOnHost('x', GREEN_HOST)).toBe(false);
  });

  it('SFW ratings are allowed on ANY host (incl. red)', async () => {
    const { ratingAllowedOnHost } = await import('../server-domain');
    for (const host of [RED_HOST, RED_ALIAS, COM_HOST, GREEN_HOST]) {
      expect(ratingAllowedOnHost('g', host)).toBe(true);
      expect(ratingAllowedOnHost('pg', host)).toBe(true);
      expect(ratingAllowedOnHost('pg13', host)).toBe(true);
    }
  });

  it('unknown/missing rating is treated as SFW → allowed anywhere (fail-closed only hides MATURE)', async () => {
    const { ratingAllowedOnHost } = await import('../server-domain');
    expect(ratingAllowedOnHost(null, COM_HOST)).toBe(true);
    expect(ratingAllowedOnHost(undefined, COM_HOST)).toBe(true);
    expect(ratingAllowedOnHost('', COM_HOST)).toBe(true);
  });

  it('confirms the trap: civitai.com is blue (color walk) yet still blocks mature', async () => {
    const { ratingAllowedOnHost, isHostForColor, getRequestDomainColor } = await import(
      '../server-domain'
    );
    // The whole point of the helper: getRequestDomainColor(.red) === 'blue', so
    // a naive color check would wrongly treat .red as SFW. isHostForColor pins
    // red capability correctly.
    expect(getRequestDomainColor({ headers: { host: RED_HOST } })).toBe('blue');
    expect(isHostForColor(RED_HOST, 'red')).toBe(true);
    expect(ratingAllowedOnHost('x', RED_HOST)).toBe(true);
    expect(isHostForColor(COM_HOST, 'red')).toBe(false);
    expect(ratingAllowedOnHost('x', COM_HOST)).toBe(false);
  });
});
