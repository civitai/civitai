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

/** Settled, graded votes in the player's history, newest last; they need the current month's vote partition. */
export async function seedGradedVotes(
  pg: PGlite,
  playerId: number,
  {
    correct = 0,
    failed = 0,
    at = '2026-12-01 00:00:00',
  }: { correct?: number; failed?: number; at?: string } = {}
) {
  const insert = (verdict: string, count: number, offset: number) =>
    pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict","settledAt","xp","gold")
       SELECT $1 + n, $2, $3::timestamp + (($4 + n) || ' seconds')::interval, 'knights.image.nsfwLevel', 0, 'Knight', '4', 1, $5, $3::timestamp, 0, 0
       FROM generate_series(1, $6::int) AS n`,
      [900000 + playerId * 10000 + offset, playerId, at, offset, verdict, count]
    );
  await insert('correct', correct, 0);
  await insert('failed', failed, correct);
}
