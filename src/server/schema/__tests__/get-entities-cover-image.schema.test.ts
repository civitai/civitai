import { describe, expect, it } from 'vitest';

/**
 * `getEntitiesCoverImage` backs a `publicProcedure`, so `entities` is a list whose
 * length is chosen by the caller. The cap is sized off what the real callers can
 * produce — a profile showcase is capped at 32 server-side, and the notification
 * panel dedupes image ids out of a 30-per-page infinite list — so the bound is far
 * above anything in the repo and only refuses lists nothing here builds.
 *
 * The numbers below are written as literals rather than read off the schema: they are
 * the contract, so changing the cap should show up here as a failure rather than
 * silently re-derive itself.
 */

import { getEntitiesCoverImage } from '~/server/schema/image.schema';

const MAX = 500;

const entities = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ entityType: 'Image' as const, entityId: i + 1 }));

const parse = (n: number) => getEntitiesCoverImage.safeParse({ entities: entities(n) });

describe('getEntitiesCoverImage bounds `entities`', () => {
  it(`accepts ${MAX} entities`, () => {
    const result = parse(MAX);

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.entities).toHaveLength(MAX);
  });

  it(`rejects ${MAX + 1} entities`, () => {
    const result = parse(MAX + 1);

    expect(result.success).toBe(false);
    // Pinned to the `entities` path so this fails on the missing cap specifically,
    // rather than passing on some other issue the schema happens to raise.
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.path[0] === 'entities')).toBe(true);
  });

  it('accepts the largest list a caller can build', () => {
    // The control for the refusal above: 32 is the showcase cap
    // (`constants.profile.showcaseItemsLimit`) and the largest fixed-size input any
    // caller has. The cap is not narrowing a real call site.
    expect(parse(32).success).toBe(true);
  });

  it('accepts an empty list', () => {
    // Deliberately not `.min(1)`. `getEntityCoverImage` early-returns [] for an empty
    // array, and every caller already guards on length, so refusing it would turn a
    // supported no-op into a 400 for token clients and buy nothing.
    expect(getEntitiesCoverImage.safeParse({ entities: [] }).success).toBe(true);
  });
});
