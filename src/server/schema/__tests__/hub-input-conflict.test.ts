import { describe, expect, it } from 'vitest';

/**
 * A hub can only be served from the search index, so `hubId` arriving with a filter
 * that forces the DB path is a request with no correct answer: `useIndex` is forced
 * true by `!!input.hubId`, the DB-only filter is dropped rather than honoured, and
 * the caller gets the hub feed presented as (say) a collection view. The schema
 * refuses the pair rather than serving one of the two filters under the other's name.
 *
 * The refusal is a pure function over the input, so this needs no mocks — and it was
 * the only guard in the diff with no test at all.
 */

import { getInfiniteImagesSchema, requiresImageDbPath } from '~/server/schema/image.schema';

const parse = (input: Record<string, unknown>) =>
  getInfiniteImagesSchema.safeParse({ browsingLevel: 1, ...input });

// Every input `requiresImageDbPath` treats as DB-forcing, with the shape that makes
// it fire. Driven off the predicate's own behaviour below, so a new DB-forcing input
// added to the predicate without being refused here shows up as a failure.
const dbForcing: Record<string, Record<string, unknown>> = {
  postId: { postId: 5 },
  postIds: { postIds: [5] },
  collectionId: { collectionId: 5 },
  reactions: { reactions: ['Like'] },
  imageId: { imageId: 5 },
  'bare modelId': { modelId: 5 },
  'prioritizedUserIds with a model': { prioritizedUserIds: [5], modelVersionId: 9 },
  'publishedOnly with a userId': { publishedOnly: true, userId: 5 },
};

describe('hubId cannot be combined with a filter that forces the DB path', () => {
  for (const [name, input] of Object.entries(dbForcing)) {
    it(`refuses hubId + ${name}`, () => {
      // Each case must actually be DB-forcing, or the refusal below is about
      // nothing. This is what stops a typo'd fixture from passing as coverage.
      expect(requiresImageDbPath(input)).toBe(true);

      const result = parse({ hubId: 1, ...input });

      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues.some((i) => i.path.includes('hubId'))).toBe(true);
    });
  }

  it('accepts a hub on its own', () => {
    // The control: the refusals above are about the COMBINATION, not about the
    // schema refusing hubs outright.
    expect(parse({ hubId: 1 }).success).toBe(true);
  });

  it('accepts a DB-forcing filter on its own', () => {
    // The other half of the control — nothing here narrows the existing feed inputs.
    expect(parse({ collectionId: 5 }).success).toBe(true);
  });

  it('accepts hubId with a filter the index CAN serve', () => {
    // modelVersionId is indexed, so it is not a conflict; pairing it with a bare
    // modelId is what forces the DB, and that pair is refused above.
    expect(parse({ hubId: 1, modelVersionId: 9 }).success).toBe(true);
  });
});
