import { type Kysely, type Selectable, type Updateable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// `target` is a Postgres enum ARRAY (TagTarget[]); `nsfw` is a scalar enum (NsfwLevel).
type TagTargetValue = Selectable<DB['Tag']>['target'][number];
type NsfwLevelValue = Selectable<DB['Tag']>['nsfw'];

export function getTagById(db: Kysely<DB>, id: number) {
  return db
    .selectFrom('Tag')
    .select(['id', 'name', 'target', 'nsfw', 'nsfwLevel', 'createdAt', 'updatedAt'])
    .where('id', '=', id)
    .executeTakeFirst();
}

export function createTag(
  db: Kysely<DB>,
  input: { name: string; target: TagTargetValue[]; nsfw?: NsfwLevelValue }
) {
  return db
    .insertInto('Tag')
    .values({
      name: input.name,
      target: input.target,
      ...(input.nsfw !== undefined ? { nsfw: input.nsfw } : {}),
      updatedAt: new Date(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

// connectOrCreate Tags by citext-unique name, returning their ids (batched). See README → Tag links.
export async function upsertTagsByName(
  db: Kysely<DB>,
  names: string[],
  target: TagTargetValue[]
): Promise<number[]> {
  if (!names.length) return [];
  await db
    .insertInto('Tag')
    .values(names.map((name) => ({ name, target, updatedAt: new Date() })))
    .onConflict((oc) => oc.column('name').doNothing())
    .execute();
  const rows = await db.selectFrom('Tag').select('id').where('name', 'in', names).execute();
  return rows.map((r) => r.id);
}

export function updateTag(db: Kysely<DB>, input: Updateable<DB['Tag']> & { id: number }) {
  const { id, ...data } = input;
  return db
    .updateTable('Tag')
    .set({ ...data })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst();
}

export function deleteTag(db: Kysely<DB>, id: number) {
  return db.deleteFrom('Tag').where('id', '=', id).execute();
}
