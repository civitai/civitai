import { createHash } from 'crypto';
import type { ModelMeta } from '~/server/schema/model.schema';
import type { SfwFaceCheckField, SfwFaceVerdict } from '~/server/services/model-sfw-face.service';

export type SfwFaceStampFace = {
  sfwName: string | null;
  sfwDescription: string | null;
  sfwCoverImageId: number | null;
};

/** What a stamp vouches for: an edit to the .com title, description or cover makes it stale. */
export function sfwFaceStampHash({ sfwName, sfwDescription, sfwCoverImageId }: SfwFaceStampFace) {
  return createHash('sha256')
    .update(JSON.stringify([sfwName, sfwDescription, sfwCoverImageId]))
    .digest('hex');
}

export function sfwFaceStamp(
  face: SfwFaceStampFace,
  promptId: number | null
): NonNullable<ModelMeta['sfwFaceCheckedAt']> {
  return { at: new Date().toISOString(), promptId, hash: sfwFaceStampHash(face) };
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
