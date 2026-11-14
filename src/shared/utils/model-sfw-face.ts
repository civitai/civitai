import {
  nsfwBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { MODEL_NAME_MAX_LENGTH } from '~/shared/constants/model-name.constants';
import { Flags } from '~/shared/utils/flags';

export const SFW_NAME_TOO_LONG_MESSAGE = `Title must be ${MODEL_NAME_MAX_LENGTH} characters or fewer.`;
export const SFW_DESCRIPTION_MAX_LENGTH = 50_000;
export const SFW_DESCRIPTION_TOO_LONG_MESSAGE = 'Description is too long.';
export const COM_FACE_REFUSED_MESSAGE =
  "Your civitai.red listing can't be shown on civitai.com. We check its title, description and trigger words, not the civitai.com fields. Edit those on the civitai.red tab and save again, or dispute this on the civitai.com tab if you think it's wrong.";
/** Shown on the civitai.com tab while the listing intent check's lock is on. */
export const COM_FACE_INTENT_LOCK_MESSAGE =
  "We read this model's civitai.red title, description and trigger words as made for sexual content, so it can't have a civitai.com version and its mature rating is locked. If that's wrong, dispute it and we'll take another look.";
export const COM_FACE_INTENT_DISPUTE_PENDING_MESSAGE =
  "Your dispute is being reviewed. We'll let you know when it's done.";
export const COM_FACE_CHECK_UNAVAILABLE_MESSAGE =
  "We couldn't check your civitai.red listing just now, so nothing was saved. Try again in a few minutes.";

/**
 * The owner's notice after the listing re-check removed a face, by why it was removed. A non-mature
 * model stays on .com through its images, so it only loses its .com cover; when that removal had no
 * verdict, there is nothing true to tell it.
 */
export function comFaceRemovedMessage(reason: 'detected' | 'recheck-unverified', mature: boolean) {
  if (reason === 'detected')
    return mature
      ? 'This model was taken off civitai.com because of its civitai.red title, description or trigger words. Edit them on the civitai.red tab. Once they pass our check, this notice clears and you can pick a civitai.com cover again.'
      : "We removed this model's civitai.com cover because of its civitai.red title, description or trigger words. The model is still on civitai.com. Edit them on the civitai.red tab, then you can pick a civitai.com cover again.";
  return mature
    ? "This model was taken off civitai.com because we couldn't check its civitai.red listing after your last edit. This was not a decision about your content. Pick your civitai.com cover again and save to retry the check."
    : null;
}

/** Why a saved .com cover does not list a mature model on .com. */
export type ComCoverState = 'version' | 'scanning' | 'unusable';
export const COM_COVER_NOT_LISTED_LABEL = 'Not listed on civitai.com';
export const comCoverStateMessages: Record<ComCoverState, string> = {
  version:
    'Your civitai.com cover must come from a published post on a published version of this model. Pick another cover.',
  scanning:
    'Your civitai.com cover is still being reviewed. The model is listed once review finishes.',
  unusable: "This image can't be used as a civitai.com cover. Pick another one.",
};

/**
 * Maps the conditions `updateModelNsfwLevels` puts on a .com cover to what the owner is told; null
 * when the cover counts. Any review or moderation state reads as `unusable`, the same as a flag, so
 * the owner cannot tell waiting on a moderator from being flagged. `scanning` is only the scanner
 * not having finished.
 */
export function comCoverState(
  image: {
    nsfwLevel: number;
    needsReview: string | null;
    tosViolation: boolean;
    acceptableMinor: boolean;
    blockedFor: string | null;
    ingestion: string;
    ownPost: boolean;
    postPublished: boolean;
    sameModel: boolean;
    versionPublished: boolean;
  } | null
): ComCoverState | null {
  if (!image) return 'unusable';
  const pending = image.ingestion === 'Pending';
  if (
    image.needsReview != null ||
    image.tosViolation ||
    image.acceptableMinor ||
    image.blockedFor != null ||
    (!pending && image.ingestion !== 'Scanned') ||
    (!pending && !isComSafeLevel(image.nsfwLevel))
  )
    return 'unusable';
  if (!image.ownPost || !image.postPublished || !image.sameModel || !image.versionPublished)
    return 'version';
  return pending ? 'scanning' : null;
}

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

/** A rating .com shows as is: rated, with only PG/PG-13 bits. What a .com cover must be. */
export function isComSafeLevel(nsfwLevel: number) {
  return nsfwLevel !== 0 && (nsfwLevel & sfwBrowsingLevelsFlag) === nsfwLevel;
}

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

/**
 * Swaps the model name on rows that name a model by id (image resources, version lists,
 * notification details) for its .com title. `sfwNames` holds only models with a face on, and is
 * empty for a viewer who gets the .red face.
 */
export function withSfwModelNames<T extends { modelId: number; modelName: string }>(
  rows: T[],
  sfwNames: ReadonlyMap<number, string>
): T[] {
  if (!sfwNames.size) return rows;
  return rows.map((row) => {
    const sfwName = sfwNames.get(row.modelId);
    return sfwName ? { ...row, modelName: sfwName } : row;
  });
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
  return images.filter((image) => isComSafeLevel(image.nsfwLevel));
}
