/**
 * An image (an article cover or banner, a profile cover) as anyone but its owner and moderators
 * may see it: only once it is scanned, rated and not awaiting review.
 */
export function servableArticleImage<
  T extends { ingestion: string; nsfwLevel: number; needsReview: string | null }
>(image: T | null | undefined): T | null {
  return image && image.ingestion === 'Scanned' && image.nsfwLevel !== 0 && !image.needsReview
    ? image
    : null;
}
