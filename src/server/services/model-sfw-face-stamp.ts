import { createHash } from 'crypto';
import type { ModelMeta } from '~/server/schema/model.schema';
import type { SfwFaceCheckField, SfwFaceVerdict } from '~/server/services/model-sfw-face.service';
import type { TextScanField } from '~/server/services/text-scan/types';
import { removeTags } from '~/utils/string-helpers';

export type SfwFaceStampFace = {
  sfwName: string | null;
  sfwDescription: string | null;
  sfwCoverImageId: number | null;
  /** The model's own version names and trigger words, which the face check reads too. */
  versionFields: TextScanField[];
};

/**
 * What a stamp vouches for: everything the face check read. An edit to the .com title, description
 * or cover, or to a version name or trigger words, makes it stale. Versions in any order hash alike.
 */
export function sfwFaceStampHash({
  sfwName,
  sfwDescription,
  sfwCoverImageId,
  versionFields,
}: SfwFaceStampFace) {
  const versions = versionFields.map((field) => `${field.heading}\n${field.text ?? ''}`).sort();
  return createHash('sha256')
    .update(JSON.stringify([sfwName, sfwDescription, sfwCoverImageId, versions]))
    .digest('hex');
}

export function sfwFaceStamp(
  face: SfwFaceStampFace,
  promptId: number | null
): NonNullable<ModelMeta['sfwFaceCheckedAt']> {
  return { at: new Date().toISOString(), promptId, hash: sfwFaceStampHash(face) };
}

/** A .com title, a .com description with text in it, and a .com cover picked. */
export function hasSfwFaceParts(face: {
  sfwName?: string | null;
  sfwDescription?: string | null;
  sfwCoverImageId?: number | null;
}) {
  return (
    !!face.sfwName?.trim() &&
    !!removeTags(face.sfwDescription ?? '').trim() &&
    face.sfwCoverImageId != null
  );
}

type FaceFields = {
  sfwName?: string | null;
  sfwDescription?: string | null;
  sfwCoverImageId?: number | null;
};

/** Whether a write of `data` over `before` leaves a model that had a complete .com face without one. */
export function losesSfwFace(before: FaceFields, data: FaceFields) {
  const pick = <K extends keyof FaceFields>(key: K) =>
    data[key] !== undefined ? data[key] : before[key];
  return (
    hasSfwFaceParts(before) &&
    !hasSfwFaceParts({
      sfwName: pick('sfwName'),
      sfwDescription: pick('sfwDescription'),
      sfwCoverImageId: pick('sfwCoverImageId'),
    })
  );
}

/** Whether the face text check passed for exactly this face. */
export function sfwFaceStampMatches(meta: unknown, face: SfwFaceStampFace) {
  const stamp = (meta as ModelMeta | null)?.sfwFaceCheckedAt;
  return !!stamp && stamp.hash === sfwFaceStampHash(face);
}

/**
 * The face check's pass, with the prompt that rated it: every field it read is clean, the title
 * among them. Anything flagged, unavailable or unread is no pass.
 */
export function passedSfwFaceCheck(
  verdicts: Partial<Record<SfwFaceCheckField, SfwFaceVerdict>>,
  { requireDescription = false }: { requireDescription?: boolean } = {}
): { promptId: number | null } | null {
  if (!verdicts.sfwName || (requireDescription && !verdicts.sfwDescription)) return null;
  const all = Object.values(verdicts);
  if (!all.every((verdict) => verdict.status === 'clean')) return null;
  const promptId = all
    .map((verdict) => verdict.status === 'clean' && verdict.promptId)
    .find((id): id is number => typeof id === 'number');
  return { promptId: promptId ?? null };
}
