/**
 * A banner standing in for a missing cover on a card, only once it is servable: the article page
 * hides a banner that is not scanned or awaits review from readers, so a card must not show it.
 */
export function servableBanner<T extends { ingestion: string; needsReview: string | null }>(
  banner: T | null | undefined
): T | null {
  return banner && banner.ingestion === 'Scanned' && !banner.needsReview ? banner : null;
}
