import { dbWrite } from './db';
import { recordModActivity } from './mod-activity';

type ReportStatus = 'Pending' | 'Processing' | 'Actioned' | 'Unactioned';

// Moderator sets an image's nsfwLevel (locks it), optionally resolves its pending rating requests, and
// records the mod activity. Shared by image-rating-review + downleveled-review.
//
// The main app's Meilisearch single-image index update is intentionally not mirrored here (it locks the
// index for a single-image change).
export async function updateImageNsfwLevel({
  id,
  nsfwLevel,
  status,
  userId,
}: {
  id: number;
  nsfwLevel: number;
  status?: ReportStatus;
  userId: number;
}): Promise<void> {
  await dbWrite
    .updateTable('Image')
    .set({ nsfwLevel, nsfwLevelLocked: true })
    .where('id', '=', id)
    .execute();

  if (status) {
    await dbWrite
      .updateTable('ImageRatingRequest')
      .set({ status })
      .where('imageId', '=', id)
      .where('status', '=', 'Pending')
      .execute();
  }

  await recordModActivity({ userId, entityType: 'image', entityId: id, activity: 'setNsfwLevel' });
}
