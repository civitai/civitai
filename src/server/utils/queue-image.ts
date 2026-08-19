/**
 * The minimum a queue image must carry. Each surface selects more — the sticker
 * queue takes `name` for its alt text — and the generic below preserves whatever
 * it selected, so widening this to a concrete shape would silently erase fields
 * the caller still reads.
 */
export type QueueThumbImage = {
  id: number;
  url: string;
  nsfwLevel: number;
};

/**
 * A review-queue image, or the fact that this domain may not be sent it.
 *
 * A discriminated union rather than a nullable `url`: the reviewer still has to
 * act on a row whose asset cannot be served here — the escrow behind it expires
 * either way — so the row must survive with its rating and its buttons, while
 * the caller must be unable to reach for pixels that were never sent. A null
 * check is forgettable in a refactor; a missing property is not.
 */
export type QueueImage<T extends QueueThumbImage = QueueThumbImage> =
  | ({ viewable: true; withinViewerLevel: boolean } & T)
  | { viewable: false; id: number; nsfwLevel: number };

/**
 * The asset is withheld, not merely unpainted.
 *
 * `ImageGuard2`'s blur is built from the viewer's own settings and never reads
 * the domain ceiling, and the review queues deliberately send no browsing level
 * — an owner has to see what is waiting on them — so on a SFW domain a component
 * was the only thing between an above-ceiling payload and the screen, and it
 * consulted the wrong field. Refusing in the payload is the control; whatever
 * the client draws is a courtesy on top of it.
 *
 * The viewer's OWN band is carried as a mark rather than applied as a filter.
 * The feed drops what is outside your band because nobody has to act on it; a
 * queue cannot, because a submission hidden that way still expires.
 *
 * Fails closed on an unrated image: `0 & mask` is 0.
 */
export function toQueueImage<T extends QueueThumbImage>(
  image: T | undefined,
  domainLevels: number,
  viewerLevels: number
): QueueImage<T> | null {
  if (!image) return null;
  if ((image.nsfwLevel & domainLevels) === 0)
    return { viewable: false, id: image.id, nsfwLevel: image.nsfwLevel };

  return {
    viewable: true,
    withinViewerLevel: (image.nsfwLevel & viewerLevels) !== 0,
    ...image,
  };
}
