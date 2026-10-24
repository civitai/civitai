import { dbRead } from '~/server/db/client';
import { getAccountLegalHold } from '~/server/services/legal-hold.service';
import { PLACEHOLDER_OWNER_ID } from '~/server/utils/legal-hold';

export type HeldMedia = { url: string; type: string; mimeType: string | null };

/**
 * The image's storage key and type, only while it is in the CSAM review queue or its owner is under
 * a legal hold. `null` otherwise, so an ordinary image is answered exactly as a missing one.
 *
 * `getAccountLegalHold` fails closed for deletion: an unreadable hold, or a marker table without its
 * view, counts as held. Here that would open every image, so only a hold it actually read counts.
 */
export async function getHeldMedia(imageId: number): Promise<HeldMedia | null> {
  const image = await dbRead.image.findUnique({
    where: { id: imageId },
    select: { url: true, type: true, mimeType: true, needsReview: true, userId: true },
  });
  if (!image) return null;
  const media = { url: image.url, type: image.type, mimeType: image.mimeType };
  if (image.needsReview === 'csam') return media;
  // A report naming the placeholder owner would otherwise open every deleted account's kept content.
  if (image.userId === PLACEHOLDER_OWNER_ID) return null;

  const hold = await getAccountLegalHold(image.userId).catch(() => null);
  const held = hold?.legs.some((leg) => leg !== 'hold-marker' || hold.markerView) ?? false;
  return held ? media : null;
}
