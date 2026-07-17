import type { Kysely, Updateable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// Generic single-image update. The caller passes the id plus whichever columns to set; `updatedAt` is stamped
// automatically (Image is a Prisma `@updatedAt` column with no DB trigger). Prefer this over a narrow
// single-column setter (e.g. clearing `needsReview`); keep a named function only for a multi-column semantic
// transition or one that needs a jsonb/CASE/proc expression. Returns the updated row.
export function updateImage(db: Kysely<DB>, input: Updateable<DB['Image']> & { id: number }) {
  const { id, ...data } = input;
  return db
    .updateTable('Image')
    .set({ ...data })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

// Bulk variant: set the same columns on many images in one statement. Guards the empty-id case (`in ()` is a
// syntax error). `updatedAt` stamped automatically.
export function updateImageMany(
  db: Kysely<DB>,
  input: { ids: number[] } & Updateable<DB['Image']>
) {
  const { ids, ...data } = input;
  if (!ids.length) return Promise.resolve([]);
  return db
    .updateTable('Image')
    .set({ ...data })
    .where('id', 'in', ids)
    .execute();
}

export function deleteImageReactionForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('ImageReaction').where('userId', '=', userId).execute();
}
export function deleteImageForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('Image').where('userId', '=', userId).execute();
}
