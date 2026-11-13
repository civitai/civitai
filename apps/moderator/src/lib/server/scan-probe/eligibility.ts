import { dbWrite } from '../db';
import { getFlagClearHolds } from '../csam-flag-clear';
import { csamExcludedImageIds } from '../relabel-csam-exclusion';
import { FLAG_KEPT_THROUGH_BLOCK } from '$lib/image-review';
import { probeMediaUrl } from './workflow';

export type ProbeImage = {
  id: number;
  userId: number;
  url: string;
  type: string;
  needsReview: string | null;
};

export type ProbeCandidate = { imageId: number; mediaUrl: string };

/**
 * 🔴 A probe copies the image's bytes into orchestrator blob storage, and no copy of CSAM-class
 * material is ever made outside the evidence path. So an image is refused when it is flagged for
 * CSAM review, owned by a user any hold leg in `csam-flag-clear` names (a CSAM report, an evidence
 * hold, a media-removing ban), or touched by any CSAM signal the relabel set excludes on — which
 * covers an image blocked for CSAM, as one of its owner's images. Every leg is pinned in
 * `scan-probe-service.pglite.test.ts`.
 */
export function isCsamClass(
  image: ProbeImage,
  heldOwners: ReadonlySet<number>,
  excluded: ReadonlySet<number>
): boolean {
  return (
    image.needsReview === FLAG_KEPT_THROUGH_BLOCK ||
    heldOwners.has(image.userId) ||
    excluded.has(image.id)
  );
}

/**
 * Splits `imageIds` into what the probe may scan and what it refuses. A missing image is refused.
 * Read from the primary: a flag or hold placed a moment ago must already refuse.
 */
export async function resolveProbeCandidates(
  imageIds: number[]
): Promise<{ eligible: ProbeCandidate[]; refused: number[] }> {
  const images: ProbeImage[] = await dbWrite
    .selectFrom('Image')
    .select(['id', 'userId', 'url', 'type', 'needsReview'])
    .where('id', 'in', imageIds)
    .execute();
  const [held, excludedRows] = await Promise.all([
    getFlagClearHolds([...new Set(images.map((i) => i.userId))], dbWrite),
    csamExcludedImageIds(imageIds).execute(dbWrite),
  ]);
  const heldOwners = new Set(held.keys());
  const excluded = new Set(excludedRows.rows.map((r) => Number(r.id)));
  const byId = new Map(images.map((i) => [i.id, i]));

  const eligible: ProbeCandidate[] = [];
  const refused: number[] = [];
  for (const id of imageIds) {
    const image = byId.get(id);
    const mediaUrl =
      image && image.type === 'image' && !isCsamClass(image, heldOwners, excluded)
        ? probeMediaUrl(image.url)
        : null;
    if (mediaUrl) eligible.push({ imageId: id, mediaUrl });
    else refused.push(id);
  }
  return { eligible, refused };
}
