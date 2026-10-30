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

export async function setGold(
  pg: PGlite,
  userId: number,
  gold: { pending?: number; earned?: number; converted?: number }
) {
  await pg.query(
    `UPDATE "NewOrderPlayer" SET "goldPending"=$2, "goldEarned"=$3, "goldConverted"=$4 WHERE "userId"=$1`,
    [userId, gold.pending ?? 0, gold.earned ?? 0, gold.converted ?? 0]
  );
}

/** One settled vote on the rating question; it needs the vote partition of `createdAt`'s month. */
export async function seedSettledVote(
  pg: PGlite,
  {
    itemId,
    playerId,
    imageId,
    gold = 0,
    answer = '4',
    createdAt = '2026-12-10 10:00:00',
    settledAt = '2026-12-10 11:00:00',
  }: {
    itemId: number;
    playerId: number;
    imageId: number;
    gold?: number;
    answer?: string;
    createdAt?: string;
    settledAt?: string;
  }
) {
  await pg.query(
    `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict","gold","xp","settledAt")
     VALUES ($1,$2,$3::timestamp,'knights.image.nsfwLevel',$4,'Knight',$5,1,'correct',$6,0,$7::timestamp)`,
    [itemId, playerId, createdAt, imageId, answer, gold, settledAt]
  );
}
