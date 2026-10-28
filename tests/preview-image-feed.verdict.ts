/**
 * What an image.getInfinite page must look like, given the `source` it names. Shared by the
 * preview smoke (tests/preview-image-feed.spec.ts) and a unit test that feeds it the real
 * getAllImagesIndex output, so the two cannot disagree about the contract.
 *
 *  - `retired`: the feeds index (`metrics_images_v1`) is retired and the reader refused it. Only
 *    the retirement guard stamps this source, so an empty page is acceptable here and nowhere
 *    else. It must be exactly the empty shape: no items, no cursor.
 *  - `feed` | `meili` | `db`: someone answered the query. The page must be a real, non-empty
 *    page. An empty `meili` page is a failure: it is what a reader that skipped the guard and
 *    returned nothing would produce.
 */
export type ImageFeedPage = {
  items?: Array<{ id?: unknown }>;
  nextCursor?: unknown;
  source?: unknown;
};

export function imageFeedVerdict(page: ImageFeedPage | undefined): string | null {
  const items = page?.items;
  if (!Array.isArray(items)) return 'image.getInfinite returned no items array';
  const source = page?.source;
  if (source === 'retired') {
    if (items.length) return `the retired index answered ${items.length} item(s); expected none`;
    if (page?.nextCursor !== undefined) return 'the retired index answered a nextCursor';
    return null;
  }
  if (source !== 'feed' && source !== 'meili' && source !== 'db')
    return `the page names no known source (got ${JSON.stringify(source)})`;
  if (!items.length) return `the /images feed (source=${source}) answered an empty page`;
  if (typeof items[0]?.id !== 'number') return 'a feed image should carry a numeric id';
  return null;
}
