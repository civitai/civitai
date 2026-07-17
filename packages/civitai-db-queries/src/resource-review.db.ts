import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

export function deleteResourceReviewForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('ResourceReview').where('userId', '=', userId).execute();
}
