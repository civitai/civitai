import { describe, expect, it } from 'vitest';
import { VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import {
  resolveRequestBrowsingLevels,
  type RequestBrowsingLevels,
} from '~/server/utils/browsing-level';

/**
 * Levels are bit flags: PG 1, PG-13 2, R 4, X 8, XXX 16.
 * Every expected value is a literal, and the viewer's saved level (13 = PG|R|X)
 * is chosen to equal none of the shared flag constants, so a resolver that
 * returned a constant instead of the viewer's own level would be visible.
 */
const VIEWER_LEVEL = 13;

type Ctx = Parameters<typeof resolveRequestBrowsingLevels>[1];

const signedIn = (showNsfw: boolean, browsingLevel = VIEWER_LEVEL) =>
  ({ id: 5, showNsfw, browsingLevel } as NonNullable<Ctx['user']>);

function resolve(
  input: RequestBrowsingLevels,
  user: Ctx['user'],
  canViewNsfw: boolean
): RequestBrowsingLevels {
  resolveRequestBrowsingLevels(input, {
    user,
    features: { canViewNsfw } as Ctx['features'],
    req: { headers: {} } as Ctx['req'],
  });
  return input;
}

describe('resolveRequestBrowsingLevels, signed in where mature content is allowed', () => {
  it('gives an omitted level the viewer’s own saved level', () => {
    expect(resolve({}, signedIn(true), true).browsingLevel).toBe(13);
  });

  it('gives an omitted level PG when the viewer has mature content off', () => {
    expect(resolve({}, signedIn(false), true).browsingLevel).toBe(1);
  });

  it('gives an omitted level PG when the viewer has no saved level', () => {
    expect(resolve({}, signedIn(true, 0), true).browsingLevel).toBe(1);
  });

  it('keeps an explicit level as sent, since this domain caps nothing', () => {
    expect(resolve({ browsingLevel: 4 }, signedIn(true), true).browsingLevel).toBe(4);
    expect(resolve({ browsingLevel: 31 }, signedIn(false), true).browsingLevel).toBe(31);
  });

  it('leaves an omitted preCapBrowsingLevel omitted', () => {
    expect(resolve({}, signedIn(true), true).preCapBrowsingLevel).toBeUndefined();
  });
});

describe('resolveRequestBrowsingLevels, signed in on the SFW domain', () => {
  it('holds an omitted level to PG/PG-13', () => {
    expect(resolve({}, signedIn(true), false).browsingLevel).toBe(3);
  });

  it('clamps an explicit level to the cap', () => {
    // 13 & 3 = 1: the PG bit survives.
    expect(resolve({ browsingLevel: 13 }, signedIn(true), false).browsingLevel).toBe(1);
    // 4 & 3 = 0: nothing in common, so the cap.
    expect(resolve({ browsingLevel: 4 }, signedIn(true), false).browsingLevel).toBe(3);
  });
});

describe('resolveRequestBrowsingLevels, signed out', () => {
  it.each([
    ['where mature content is allowed', true],
    ['on the SFW domain', false],
  ] as const)('gives an omitted level PG %s', (_label, canViewNsfw) => {
    expect(resolve({}, undefined, canViewNsfw).browsingLevel).toBe(1);
  });

  it('clamps an explicit level to PG', () => {
    expect(resolve({ browsingLevel: 13 }, undefined, true).browsingLevel).toBe(1);
    expect(resolve({ browsingLevel: 4 }, undefined, true).browsingLevel).toBe(1);
  });

  // A verified crawler is uncapped where mature content is allowed, but it has no
  // saved level of its own, so the signed-in default must not reach it.
  it('leaves an omitted level omitted for a verified crawler where mature content is allowed', () => {
    const input: RequestBrowsingLevels = {};
    resolveRequestBrowsingLevels(input, {
      user: undefined,
      features: { canViewNsfw: true } as Ctx['features'],
      req: { headers: { [VERIFIED_BOT_HEADER]: 'googlebot' } } as unknown as Ctx['req'],
    });
    expect(input.browsingLevel).toBeUndefined();
  });
});
