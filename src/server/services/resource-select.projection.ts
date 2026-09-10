import type { ImagesForModelVersions } from '~/server/services/image.service';
import { selectSlimGetAllModelImages } from '~/server/utils/model-getall-images';
import type { TransformedModel } from '~/shared/search/models-transform';

/**
 * Wire projection for `model.getResourceSelect`.
 *
 * The picker was shipping 1,562,693 uncompressed bytes per 50-item page (367,783
 * brotli) to render ~31 cards. This drops the fields no consumer in the modal reads
 * and caps the per-model image array, WITHOUT changing anything the UI renders.
 *
 * Deliberately conservative: every field the flip-out detail panel reads is kept, so
 * this PR has no visible behaviour. Deferring those to an on-click fetch is a much
 * larger win but needs a new endpoint and a loading state, so it is separate.
 *
 * Applied to the merged list (Meili hits AND the Postgres official pin) at a single
 * point, so the two sources cannot drift apart. They already had: the pin path returns
 * `sortMetrics` and a key-present `cannotPromote` that Meili omits.
 *
 * WHITELIST, never blacklist. The two sources have different key sets, so a blacklist
 * tuned against the Meili shape would leak the pin path's `sortMetrics` — the real
 * Creator Controls download/tip counts — on the item pinned to position 1 of every
 * default browse.
 */

// Coverage-complete at 6: an image nsfwLevel is always a single bit and there are at
// most 6 distinct levels, so every level keeps a representative and no viewer loses
// the only cover they could see. A naive slice does NOT hold that property and
// silently drops models via the hidden-preferences no-images path.
export const RESOURCE_SELECT_IMAGES_PER_MODEL = 6;

export const RESOURCE_SELECT_MODEL_KEYS = [
  'id',
  'name',
  'type',
  // Consumed: nsfwLevel/nsfw/minor/poi/tags/user by the hidden-preferences pass that
  // decides whether the card exists at all; dropping any of them silently empties the
  // grid or stops the content-safety gates firing.
  'nsfwLevel',
  'nsfw',
  'minor',
  'poi',
  'tags',
  'user',
  'availability',
  'checkpointType',
  'permissions',
  'cannotPromote',
  'cosmetic',
  'publishedAt',
  'lastVersionAt',
  // Model-level hashes feeds CivitaiLinkManageButton, which dereferences it BEFORE its
  // own null guard — dropping it is a TypeError for any Civitai-Link-connected user.
  'hashes',
  'version',
  'versions',
  'images',
] as const;

// Dropped from each version: `flags` and `hashes`. `hashes` is the raw string[] and is
// 153KB/page of pure waste — only `hashData` is rendered (ModelHash, on the flip panel).
export const RESOURCE_SELECT_VERSION_KEYS = [
  'id',
  'name',
  'baseModel',
  // Tri-state and compared by IDENTITY in filterResourceVersions. Omitting it, or
  // coercing undefined to false, strips every version from every model.
  'canGenerate',
  'nsfwLevel',
  // Flip-panel only, kept so the detail panel keeps working.
  'baseModelType',
  'createdAt',
  'metrics',
  'steps',
  'epochs',
  'clipSkip',
  'settings',
  'trainedWords',
  'hashData',
] as const;

// Dropped: `sizeKB`, `remixOfId`, `hasPositivePrompt` — no consumer, not even a type.
export const RESOURCE_SELECT_IMAGE_KEYS = [
  'id',
  'url',
  'name',
  'type',
  'width',
  'height',
  'hash',
  'nsfwLevel',
  'userId',
  'tags',
  'poi',
  'minor',
  // Required by the BidModelButton entityData type rather than read at runtime.
  'modelVersionId',
  'availability',
  'onSite',
  'hasMeta',
] as const;

function pick<T extends object, K extends readonly (keyof T)[]>(
  source: T,
  keys: K
): Pick<T, K[number]> {
  const out = {} as Pick<T, K[number]>;
  for (const key of keys) {
    // Only copy keys the source actually has. `canGenerate` is absent on most versions
    // and `undefined` on some, and assigning unconditionally would collapse those into
    // one shape — harmless for the identity compare, but it invents keys the endpoint
    // never sent and makes superjson emit an `undefined` marker for each one.
    if (key in source) out[key] = source[key];
  }
  return out;
}

export function projectResourceSelectItems(items: TransformedModel[]) {
  return items.map((item) => ({
    ...pick(item, RESOURCE_SELECT_MODEL_KEYS),
    // `baseModel` is the only field of the singular `version` the modal reads, and it
    // is 2.9% of the page on its own.
    version: { baseModel: item.version.baseModel },
    versions: item.versions.map((version) => pick(version, RESOURCE_SELECT_VERSION_KEYS)),
    images: selectSlimGetAllModelImages(item.images, RESOURCE_SELECT_IMAGES_PER_MODEL).map(
      (image) => ({
        ...pick(image, RESOURCE_SELECT_IMAGE_KEYS),
        // Type-required by the auction entityData, read by nothing in the modal.
        // Same annotated-null idiom as auction.service.ts.
        metadata: null as ImagesForModelVersions['metadata'],
      })
    ),
  }));
}

// Derived from the function rather than hand-written, matching the `TransformedModel`
// idiom. TransformedModel is an object-spread type, so its overridden keys are
// intersections (`tags: {id,name}[] & number[]`) that a hand-written Pick<> cannot
// reproduce — deriving keeps the wire type and the projection provably in sync.
export type ResourceSelectItem = ReturnType<typeof projectResourceSelectItems>[number];
