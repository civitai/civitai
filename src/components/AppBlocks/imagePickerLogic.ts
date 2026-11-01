import { PICKER_JUMP_MIN_DATE } from '~/server/schema/blocks/block-image-picker.schema';
import { isCivitaiHostedImageUrl } from '~/server/schema/blocks/civitai-image-url';
import type { PostedPickableImage } from '~/server/services/blocks/block-image-picker.logic';
import {
  browsingLevels,
  orchestratorNsfwLevelMap,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';

/**
 * `OPEN_IMAGE_PICKER` → `IMAGE_PICKER_RESULT`: the decisions the page host makes about an untrusted
 * request and about what it answers, kept pure so they are unit-testable. The modal
 * (`BlockImagePickerModal`) lists the viewer's library; the app only ever receives a pick.
 */

export const IMAGE_PICKER_SOURCES = ['posted', 'generated'] as const;
export type BlockImagePickerSource = (typeof IMAGE_PICKER_SOURCES)[number];

/** Most images one multi-pick request can return. A larger `multiple.max` is clamped to it. */
export const IMAGE_PICKER_MULTIPLE_MAX = 20;

export type BlockPickedImageInfo = {
  source: BlockImagePickerSource;
  url: string;
  /** Pixel size the image at `url` is requested at; see `postedPickRendition` for posted picks. */
  width: number;
  height: number;
  nsfwLevel: number;
  /** `Image` row id. Posted picks only: a generator output has no row. */
  imageId?: number;
};

export const IMAGE_PICKER_SOURCES_ERROR =
  'OPEN_IMAGE_PICKER: sources must be a non-empty list of "posted" and/or "generated".';
export const IMAGE_PICKER_MULTIPLE_ERROR =
  'OPEN_IMAGE_PICKER: multiple.max must be a whole number of at least 1.';
export const IMAGE_PICKER_PUBLIC_ONLY_ERROR = 'OPEN_IMAGE_PICKER: publicOnly must be a boolean.';

export type ImagePickerRequest = {
  requestId: string;
  /** De-duplicated, in the order the app asked for them. */
  sources: BlockImagePickerSource[];
  /** `null` for a single pick; otherwise the clamped cap of a multi pick. */
  max: number | null;
  /**
   * Posted images only from a post that is not Private (`postedPickableWhere`). `false` when the
   * app did not ask. Generated images are listed as before either way.
   */
  publicOnly: boolean;
};

export type ImagePickerDecision =
  | { kind: 'drop' }
  | { kind: 'refuse'; requestId: string; error: string }
  | { kind: 'open'; request: ImagePickerRequest };

const isSource = (value: unknown): value is BlockImagePickerSource =>
  (IMAGE_PICKER_SOURCES as readonly unknown[]).includes(value);

/**
 * Validate a raw `OPEN_IMAGE_PICKER` payload. Without a usable `requestId` there is nothing to
 * correlate a reply to, so the message is dropped; every other invalid request is refused with an
 * `error` the SDK turns into a rejection, never downgraded to a different request than was sent.
 */
export function resolveImagePickerRequest(raw: unknown): ImagePickerDecision {
  if (!raw || typeof raw !== 'object') return { kind: 'drop' };
  const obj = raw as Record<string, unknown>;
  if (typeof obj.requestId !== 'string' || obj.requestId.length === 0) return { kind: 'drop' };
  const requestId = obj.requestId;

  let sources: BlockImagePickerSource[] = [...IMAGE_PICKER_SOURCES];
  if (obj.sources !== undefined) {
    if (!Array.isArray(obj.sources) || obj.sources.length === 0 || !obj.sources.every(isSource)) {
      return { kind: 'refuse', requestId, error: IMAGE_PICKER_SOURCES_ERROR };
    }
    sources = Array.from(new Set(obj.sources));
  }

  let max: number | null = null;
  if (obj.multiple !== undefined) {
    const requested =
      obj.multiple && typeof obj.multiple === 'object'
        ? (obj.multiple as Record<string, unknown>).max
        : undefined;
    if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1) {
      return { kind: 'refuse', requestId, error: IMAGE_PICKER_MULTIPLE_ERROR };
    }
    max = Math.min(requested, IMAGE_PICKER_MULTIPLE_MAX);
  }

  if (obj.publicOnly !== undefined && typeof obj.publicOnly !== 'boolean') {
    return { kind: 'refuse', requestId, error: IMAGE_PICKER_PUBLIC_ONLY_ERROR };
  }
  const publicOnly = obj.publicOnly === true;

  return { kind: 'open', request: { requestId, sources, max, publicOnly } };
}

export const isSamePick = (
  a: Pick<BlockPickedImageInfo, 'source' | 'url'>,
  b: Pick<BlockPickedImageInfo, 'source' | 'url'>
) => a.source === b.source && a.url === b.url;

type PickIdentity = Pick<BlockPickedImageInfo, 'source' | 'url'>;

/**
 * The selection after the viewer clicks `image`: a selected image is removed, a single pick
 * (`max: null`) is replaced, and a multi pick grows only while it is under `max`.
 */
export function togglePickedImage<T extends PickIdentity>(
  current: readonly T[],
  image: T,
  max: number | null
): T[] {
  if (current.some((s) => isSamePick(s, image))) return removePickedImage(current, image);
  if (max === null) return [image];
  return current.length >= max ? [...current] : [...current, image];
}

/** The selection without `image`, the order of the rest kept. */
export function removePickedImage<T extends PickIdentity>(
  current: readonly T[],
  image: PickIdentity
): T[] {
  return current.filter((s) => !isSamePick(s, image));
}

/** Pick order kept, a repeated image collapsed onto its first occurrence, never more than `max`. */
export function capPickedImages<T extends Pick<BlockPickedImageInfo, 'source' | 'url'>>(
  picked: readonly T[],
  max: number
): T[] {
  const out: T[] = [];
  for (const image of picked) {
    if (out.length >= max) break;
    if (!out.some((kept) => isSamePick(kept, image))) out.push(image);
  }
  return out;
}

// Rebuilt field by field so nothing the modal attaches to a pick can reach the app.
function toWirePick(image: BlockPickedImageInfo): BlockPickedImageInfo {
  const { source, url, width, height, nsfwLevel, imageId } = image;
  return {
    source,
    url,
    width,
    height,
    nsfwLevel,
    ...(source === 'posted' && typeof imageId === 'number' ? { imageId } : {}),
  };
}

export type ImagePickerReply =
  | { requestId: string; selected?: BlockPickedImageInfo }
  | { requestId: string; selectedImages: BlockPickedImageInfo[] };

/**
 * The `IMAGE_PICKER_RESULT` payload for what the viewer confirmed (`[]` when they dismissed). A
 * single pick answers `selected` or nothing; a multi pick always answers `selectedImages`, so the
 * two shapes cannot be mistaken for one another.
 */
export function buildImagePickerReply(
  request: Pick<ImagePickerRequest, 'requestId' | 'max'>,
  picked: readonly BlockPickedImageInfo[]
): ImagePickerReply {
  const { requestId, max } = request;
  if (max === null) {
    const [first] = picked;
    return first ? { requestId, selected: toWirePick(first) } : { requestId };
  }
  return { requestId, selectedImages: capPickedImages(picked, max).map(toWirePick) };
}

const isPixelSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/**
 * A posted image as a pick. Which images are listed is the server's decision
 * (`postedPickableWhere`); `null` here only stops a pick that could not be used from being sent:
 * one without a whole pixel size, or whose url is not on a Civitai image host.
 */
export function projectPostedPick(image: PostedPickableImage): BlockPickedImageInfo | null {
  if (!isPixelSize(image.width) || !isPixelSize(image.height)) return null;
  if (!isCivitaiHostedImageUrl(image.url)) return null;
  return {
    source: 'posted',
    url: image.url,
    width: image.width,
    height: image.height,
    nsfwLevel: image.nsfwLevel,
    imageId: image.imageId,
  };
}

export type GeneratedPickCandidate = {
  type: string;
  url: string;
  width?: number | null;
  height?: number | null;
  /** The orchestrator's rating (`'pg'`, `'pg13'`, …) or an already-mapped level. */
  nsfwLevel?: string | number | null;
};

/**
 * The level a generator rating names, or `undefined`. An own-property lookup: a rating string like
 * `constructor` must not resolve through the prototype.
 */
export function ratingToLevel(rating: GeneratedPickCandidate['nsfwLevel']): number | undefined {
  if (typeof rating === 'number') return rating;
  if (typeof rating !== 'string') return undefined;
  const key = rating.toLowerCase();
  return Object.prototype.hasOwnProperty.call(orchestratorNsfwLevelMap, key)
    ? orchestratorNsfwLevelMap[key]
    : undefined;
}

/**
 * A generator output as a pick, or `null` when it may not be offered: not an image, without a
 * rating that maps to one known level (the rating is the only maturity signal an output has, so an
 * absent or unrecognised one fails closed), rated at a level `browsingLevel` does not include,
 * without a size, or not on a Civitai image host.
 */
export function projectGeneratedPick(
  output: GeneratedPickCandidate,
  browsingLevel: number
): BlockPickedImageInfo | null {
  if (output.type !== 'image') return null;
  const nsfwLevel = ratingToLevel(output.nsfwLevel);
  if (nsfwLevel === undefined || !(browsingLevels as readonly number[]).includes(nsfwLevel)) {
    return null;
  }
  if (!Flags.hasFlag(browsingLevel, nsfwLevel)) return null;
  if (!isPixelSize(output.width) || !isPixelSize(output.height)) return null;
  if (!isCivitaiHostedImageUrl(output.url)) return null;
  return {
    source: 'generated',
    url: output.url,
    width: output.width,
    height: output.height,
    nsfwLevel,
  };
}

/** Consecutive pages with nothing pickable after which a grid stops loading the next one itself. */
export const MAX_EMPTY_AUTO_PAGES = 3;

/**
 * Narrowest a grid tile is drawn: the grid has as many columns as fit at this width. A phone-width
 * grid takes smaller tiles, so even a 320px screen shows three to a row.
 */
export const PICKER_TILE_MIN_PX = { narrow: 88, wide: 120 } as const;
/** Grids narrower than this use the `narrow` minimum. */
export const PICKER_NARROW_GRID_PX = 600;
export const PICKER_TILE_GAP_PX = 8;

/**
 * Columns and square tile size for a grid `width` px wide. Tiles share the width left after the
 * gaps, so they are never narrower than `minTile` unless one column is all that fits.
 */
export function pickerGridLayout(
  width: number,
  minTile: number = width < PICKER_NARROW_GRID_PX
    ? PICKER_TILE_MIN_PX.narrow
    : PICKER_TILE_MIN_PX.wide,
  gap = PICKER_TILE_GAP_PX
): { columns: number; tile: number } {
  const usable = Math.max(0, width);
  const columns = Math.max(1, Math.floor((usable + gap) / (minTile + gap)));
  const tile = Math.max(0, Math.floor((usable - gap * (columns - 1)) / columns));
  return { columns, tile };
}

/**
 * How long a jump-to date has to hold still before the list is replaced for it. Applying every
 * intermediate value as it is typed or stepped through would swap the grid to a new, briefly empty
 * list on each one; the list is replaced once, for the date the viewer stops on.
 */
export const PICKER_JUMP_DEBOUNCE_MS = 400;

/**
 * A native date input's `YYYY-MM-DD` as the newest moment a "jump to date" list may show: the END
 * of that day in the viewer's time zone, so images from the chosen day itself are listed. `null`
 * for an empty, malformed or impossible value, or one before `PICKER_JUMP_MIN_DATE`: no bound, the
 * list starts at the newest image. A year still being typed reads as 0002, 0020, 0202; were those
 * applied, the grid would flash empty for a date nobody meant.
 */
export function jumpDateToBound(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const bound = new Date(year, month, day, 23, 59, 59, 999);
  // `new Date` rolls an impossible day over (Feb 30 → Mar 2); that is not the day that was asked.
  if (bound.getFullYear() !== year || bound.getMonth() !== month || bound.getDate() !== day) {
    return null;
  }
  return bound < PICKER_JUMP_MIN_DATE ? null : bound;
}

/** A local date as the `YYYY-MM-DD` a native date input takes. */
export function toDateInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Whether the posted picks have to go when the posted list on screen changes.
 *
 * A list replaced while the viewer kept the same date bound was replaced because what they may see
 * changed (a browsing-level change resets it), so picks made from the old list go with it. A list
 * replaced because the viewer jumped to another date is the same library seen from elsewhere: its
 * picks are still theirs to use, so they stay. The first list after a mount replaces nothing.
 */
export function shouldDropPostedPicks(
  previous: { listKey: unknown; bound: number | undefined },
  next: { listKey: unknown; bound: number | undefined }
): boolean {
  if (previous.bound !== next.bound) return false;
  return previous.listKey !== undefined && previous.listKey !== next.listKey;
}
