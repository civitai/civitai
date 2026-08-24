import { describe, expect, it } from 'vitest';

/**
 * `getEntitiesCoverImage` backs a `publicProcedure`, so `entities` is a list whose
 * length is chosen by the caller. The cap is sized off what the real callers can
 * produce — `addEntityToShowcase` truncates a showcase to 32, and the notification
 * panel dedupes image ids out of a 30-per-page infinite list — so the bound is far
 * above anything in the repo and only refuses lists nothing here builds. Each caller
 * clamps its own list to `MAX_ENTITIES_COVER_IMAGE` before querying, so the bound is
 * a backstop rather than something a session can walk into.
 *
 * The numbers below are written as literals rather than read off the schema: they are
 * the contract, so changing the cap should show up here as a failure rather than
 * silently re-derive itself.
 */

import { getEntitiesCoverImage } from '~/server/schema/image.schema';

const MAX = 500;

// Ids sit far above the cap and never co-vary with the array index, which is what
// makes this suite able to see WHICH bound it is testing. Built as `i + 1` the ids
// run 1..n, so a `.max(500)` moved off the array and onto `entityId` refuses exactly
// the same inputs — the suite stays green while the array itself is unbounded, and
// every real request (image ids are far above 500) 400s. At 900_000 + i a relocated
// bound rejects the accepted cases too, so the mutant cannot hide.
const entities = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ entityType: 'Image' as const, entityId: 900_000 + i }));

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
    // Pinned to the whole issue, not `path[0]`: a length bound relocated onto
    // `entityId` raises `too_big` at `['entities', 500, 'entityId']`, which also has
    // `entities` at path[0]. Requiring the path to BE `['entities']` is what makes
    // this an assertion about the array's own length rather than about any bound
    // that happens to live somewhere under `entities`.
    if (!result.success)
      expect(
        result.error.issues.map((issue) => ({ code: issue.code, path: issue.path }))
      ).toContainEqual({ code: 'too_big', path: ['entities'] });
  });

  it('accepts the largest list a caller can build', () => {
    // The control for the refusal above: 32 is what `addEntityToShowcase` truncates a
    // showcase to (`constants.profile.showcaseItemsLimit`), i.e. the size the ordinary
    // showcase path produces. The cap is not narrowing a real call site.
    expect(parse(32).success).toBe(true);
  });

  it('accepts an empty list', () => {
    // Deliberately not `.min(1)`. `getEntityCoverImage` early-returns [] for an empty
    // array, and every caller already guards on length, so refusing it would turn a
    // supported no-op into a 400 for token clients and buy nothing.
    expect(getEntitiesCoverImage.safeParse({ entities: [] }).success).toBe(true);
  });
});
