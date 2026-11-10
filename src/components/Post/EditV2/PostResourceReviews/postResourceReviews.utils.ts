type ReviewRow = {
  modelVersionId?: number | null;
  reviewId?: number | null;
  reviewRating?: number | null;
  reviewRecommended?: boolean | null;
  reviewDetails?: string | null;
  reviewCreatedAt?: Date | null;
};

export type ReviewPatch = Partial<
  Pick<
    ReviewRow,
    'reviewId' | 'reviewRating' | 'reviewRecommended' | 'reviewDetails' | 'reviewCreatedAt'
  >
>;

/** One row per model version; the post query can return a version more than once. */
export function dedupeByModelVersion<T extends ReviewRow>(rows: T[]): T[] {
  const seen = new Set<number>();
  return rows.filter((row) => {
    if (!row.modelVersionId || seen.has(row.modelVersionId)) return false;
    seen.add(row.modelVersionId);
    return true;
  });
}

export function countReviews(rows: ReviewRow[]) {
  return { rated: rows.filter((row) => row.reviewRecommended != null).length, total: rows.length };
}

export function patchReview<T extends ReviewRow>(
  rows: T[],
  modelVersionId: number,
  patch: ReviewPatch
): T[] {
  return rows.map((row) => (row.modelVersionId === modelVersionId ? { ...row, ...patch } : row));
}

/** Rich-text editors report an empty document as markup, e.g. `<p></p>`. */
export const normalizeComment = (html: string | null | undefined) =>
  !html || html.replace(/<(?!img\b)[^>]*>/g, '').trim() === '' ? '' : html;

export const shouldNudgeForComment = ({
  recommended,
  comment,
}: {
  recommended: boolean | null | undefined;
  comment: string | null | undefined;
}) => recommended === false && normalizeComment(comment) === '';
