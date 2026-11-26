import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer, seedSettledVote } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { servedHistory } from './cadence';
import { importYesNo } from './import';

const NOW = new Date('2026-12-21T12:00:00Z');

let pg: PGlite;
let db: Kysely<DB>;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","Image","Post" RESTART IDENTITY CASCADE; DELETE FROM "KnightsQuestion" WHERE key LIKE 'knights.yesno.%'`
  );
});

async function yesNoItem(imageId: number) {
  await seedImage(pg, imageId);
  await importYesNo(db, [
    {
      externalId: `q${imageId}`,
      imageId,
      axis: 'violence',
      audience: 'players',
      prompt: `Question ${imageId}?`,
      yesEffect: 'R4',
      noEffect: 'R3',
      meta: {},
    },
  ]);
  const { rows } = await pg.query<{ id: number }>(
    `SELECT id FROM "KnightsQueueItem" WHERE "imageId" = $1`,
    [imageId]
  );
  return rows[0].id;
}
const at = (second: number) => `2026-12-21 10:00:${String(second).padStart(2, '0')}`;

describe('servedHistory', () => {
  it('lists the player’s recent votes oldest first, a yes/no question apart from a rating or a hidden check', async () => {
    await seedPlayer(pg, 1);
    const question = await yesNoItem(50);
    await seedSettledVote(pg, { itemId: 9001, playerId: 1, imageId: 10, createdAt: at(1) });
    await seedSettledVote(pg, { itemId: question, playerId: 1, imageId: 50, createdAt: at(2) });
    await seedSettledVote(pg, { itemId: -7, playerId: 1, imageId: 11, createdAt: at(3) });

    expect(await servedHistory(db, 1)).toEqual([
      { yesno: false, key: 'r9001' },
      { yesno: true, key: `y${question}` },
      { yesno: false, key: 'r-7' },
    ]);
  });

  it('adds the items handed out ahead after the votes, leaving out any that already has its vote', async () => {
    await seedPlayer(pg, 1);
    const question = await yesNoItem(50);
    await seedSettledVote(pg, { itemId: 9001, playerId: 1, imageId: 10, createdAt: at(1) });

    const history = await servedHistory(db, 1, [
      { kind: 'queue', id: 9001 },
      { kind: 'hidden', id: 7 },
      { kind: 'yesno', id: question },
      { kind: 'queue', id: 9002 },
    ]);
    expect(history).toEqual([
      { yesno: false, key: 'r9001' },
      { yesno: false, key: 'r-7' },
      { yesno: true, key: `y${question}` },
      { yesno: false, key: 'r9002' },
    ]);
  });

  it('reads only the last 11 votes, enough for the longest gap and the item before it', async () => {
    await seedPlayer(pg, 1);
    for (let i = 1; i <= 15; i++)
      await seedSettledVote(pg, { itemId: 9000 + i, playerId: 1, imageId: 10, createdAt: at(i) });
    const history = await servedHistory(db, 1);
    expect(history).toHaveLength(11);
    expect(history[0].key).toBe('r9005');
    expect(history.at(-1)?.key).toBe('r9015');
  });
});
