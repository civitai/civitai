import type { PGlite } from '@electric-sql/pglite';

export async function seedPlayer(
  pg: PGlite,
  userId: number,
  rankType = 'Knight',
  { startAt }: { startAt?: string } = {}
) {
  await pg.query(
    `INSERT INTO "NewOrderPlayer" ("userId","rankType","startAt") VALUES ($1,$2,COALESCE($3::timestamp, '2020-01-01'))`,
    [userId, rankType, startAt ?? null]
  );
}

export async function seedImage(
  pg: PGlite,
  id: number,
  {
    nsfwLevel = 4,
    publishedAt = '2020-01-01',
  }: { nsfwLevel?: number; publishedAt?: string | null } = {}
) {
  await pg.query(`INSERT INTO "Post" ("id","publishedAt") VALUES ($1,$2)`, [id, publishedAt]);
  await pg.query(`INSERT INTO "Image" ("id","url","nsfwLevel","postId") VALUES ($1,$2,$3,$1)`, [
    id,
    `key-${id}`,
    nsfwLevel,
  ]);
}
