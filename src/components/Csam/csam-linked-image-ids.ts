const MAX_LINKED_IMAGE_IDS = 500;

type QueryValue = string | string[] | undefined;

/**
 * The images a report link preselects: `imageId=<id>` and/or `imageIds=<id>,<id>,...`, in link order,
 * without duplicates or anything that is not a positive integer id.
 */
export function parseLinkedImageIds(query: { imageId?: QueryValue; imageIds?: QueryValue }) {
  const raw = [query.imageId, query.imageIds]
    .flat()
    .filter((v): v is string => typeof v === 'string')
    .flatMap((v) => v.split(','));
  const ids = raw.map((v) => Number(v.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
  return [...new Set(ids)].slice(0, MAX_LINKED_IMAGE_IDS);
}

/** The user's images the link named (in link order), the named ids the user no longer has, and the rest. */
export function splitLinkedImages<T extends { id: number }>(images: T[], imageIds: number[]) {
  const byId = new Map(images.map((x) => [x.id, x]));
  const linkedImages = imageIds.flatMap((id) => byId.get(id) ?? []);
  const linkedIds = new Set(linkedImages.map((x) => x.id));
  return {
    linkedImages,
    missingImageIds: imageIds.filter((id) => !byId.has(id)),
    gridImages: images.filter((x) => !linkedIds.has(x.id)),
  };
}
