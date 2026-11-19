import { describe, expect, it } from 'vitest';
import {
  countReviews,
  dedupeByModelVersion,
  patchReview,
} from '~/components/Post/EditV2/PostResourceReviews/postResourceReviews.utils';

describe('postResourceReviews.utils', () => {
  it('keeps one row per model version and counts only rated ones', () => {
    const rows = dedupeByModelVersion([
      { modelVersionId: 1, reviewRecommended: true },
      { modelVersionId: 1, reviewRecommended: true },
      { modelVersionId: 2, reviewRecommended: false },
      { modelVersionId: 3, reviewRecommended: null },
      { modelVersionId: null, reviewRecommended: null },
    ]);
    expect(rows.map((r) => r.modelVersionId)).toEqual([1, 2, 3]);
    expect(countReviews(rows)).toEqual({ rated: 2, total: 3 });
  });

  it('patches only the matching model version', () => {
    const rows = [{ modelVersionId: 1 }, { modelVersionId: 2 }];
    expect(patchReview(rows, 2, { reviewRecommended: true })).toEqual([
      { modelVersionId: 1 },
      { modelVersionId: 2, reviewRecommended: true },
    ]);
  });
});
