import {
  nsfwBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';

/**
 * A model's .com face: `Model.sfwName` / `sfwDescription`, shown in place of the name and
 * description to viewers who see no mature content. Not `sfwOnly`, which restricts what the
 * resource may generate.
 */
export type ModelSfwFaceSource = {
  name: string;
  description?: string | null;
  sfwName?: string | null;
  sfwDescription?: string | null;
};

/** An empty input or an empty RTE document is stored as NULL, never as a blank face. */
export function normalizeSfwFaceText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '<p></p>') return null;
  return value ?? null;
}

/**
 * True when the viewer's browsing level holds no mature bits: everyone on .com, and anyone signed
 * out. An unknown level means a server-side caller with no viewer, which keeps the .red face.
 */
export function showsSfwFace(browsingLevel: number | null | undefined) {
  return !!browsingLevel && !Flags.intersects(browsingLevel, nsfwBrowsingLevelsFlag);
}

/**
 * The name and description this viewer should see, without the stored .com pair. A face is on
 * when `sfwName` is set; its description is not filled from the .red one when left blank.
 * Returns a new object, as callers pass rows from shared caches.
 */
export function resolveModelFace<T extends ModelSfwFaceSource>(
  model: T,
  showSfwFace: boolean
): Omit<T, 'sfwName' | 'sfwDescription'> {
  const { sfwName, sfwDescription, ...rest } = model;
  if (!showSfwFace || sfwName == null) return rest;
  return {
    ...rest,
    name: sfwName,
    ...('description' in model ? { description: sfwDescription ?? null } : {}),
  };
}

/** Normalises a write that carries the face. Clearing the title turns the face off, description included. */
export function normalizeSfwFaceInput(data: {
  sfwName?: string | null;
  sfwDescription?: string | null;
}) {
  if (data.sfwName !== undefined) data.sfwName = normalizeSfwFaceText(data.sfwName);
  if (data.sfwDescription !== undefined)
    data.sfwDescription = normalizeSfwFaceText(data.sfwDescription);
  if (data.sfwName === null) data.sfwDescription = null;
}

/** The name a search hit renders with; only model hits carry a face. */
export function searchHitName(
  hit: { name: string; sfwName?: string | null },
  showSfwFace: boolean
) {
  return (showSfwFace && hit.sfwName) || hit.name;
}

/**
 * Whether a model's .com face is complete: a .com title and a .com cover the level computation
 * accepted, which is what puts safe bits in a mature model's `nsfwLevel`.
 */
export function hasCompleteSfwFace(model: {
  sfwName?: string | null;
  sfwCoverImageId?: number | null;
  nsfwLevel: number;
}) {
  return (
    model.sfwName != null &&
    model.sfwCoverImageId != null &&
    Flags.intersects(model.nsfwLevel, sfwBrowsingLevelsFlag)
  );
}

/** The cover a viewer gets: the .com one with a complete face, otherwise the creator's .red pick. */
export function pickCoverImageId(
  model: { hasSfwFace?: boolean; coverImageId?: number | null; sfwCoverImageId?: number | null },
  showSfwFace: boolean
) {
  return (showSfwFace && model.hasSfwFace ? model.sfwCoverImageId : model.coverImageId) ?? null;
}

/** Puts the chosen cover first. Returns the list unchanged when there is no cover. */
export function hoistCoverImage<T extends { id: number }>(images: T[], cover: T | undefined): T[] {
  if (!cover) return images;
  return [cover, ...images.filter((image) => image.id !== cover.id)];
}

/** A mature model listed on .com through its face sends that viewer only its PG/PG-13 images. */
export function imagesForFace<T extends { nsfwLevel: number }>(
  images: T[],
  model: { nsfw?: boolean; hasSfwFace?: boolean },
  showSfwFace: boolean
) {
  if (!showSfwFace || !model.nsfw || !model.hasSfwFace) return images;
  return images.filter(
    (image) =>
      image.nsfwLevel !== 0 && (image.nsfwLevel & sfwBrowsingLevelsFlag) === image.nsfwLevel
  );
}
