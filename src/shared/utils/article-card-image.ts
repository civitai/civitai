/**
 * An article's cover or banner as anyone but its owner and moderators may see it: only once it is
 * scanned and not awaiting review. The article page hides any other, so no card, search document
 * or share image may show it either.
 */
export function servableArticleImage<T extends { ingestion: string; needsReview: string | null }>(
  image: T | null | undefined
): T | null {
  return image && image.ingestion === 'Scanned' && !image.needsReview ? image : null;
}
