import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_NSFW_LEVEL_QUESTION } from '@civitai/shared/new-order';
import { createQueueDb } from '../../../test/pglite-kysely';
import {
  applyPendingResolutions,
  enqueueItem,
  ensureVotePartitions,
  escalateExpired,
  type QueueDeps,
} from './queue.service';

const Q = KNIGHTS_NSFW_LEVEL_QUESTION;
const NOW = new Date('2026-12-15T12:00:00Z');
const PAST = new Date('2026-12-15T11:00:00Z');
const script = (name: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../../scripts/backfill-no-consensus-rerate/${name}`, import.meta.url)
    ),
    'utf8'
  );

let pg: PGlite;
let db: Kysely<DB>;
const applyConsensus = vi.fn<QueueDeps['applyConsensus']>(async () => ({ outcome: 'applied' }));

/** [stage, answer, weight]; each vote is one second after the one before, so the latest voter is well defined. */
type SeededVote = [string, string, number];

async function seedImage(id: number, nsfwLevel: number) {
  await pg.query(`INSERT INTO "Post" ("id","publishedAt") VALUES ($1,'2020-01-01')`, [id]);
  await pg.query(`INSERT INTO "Image" ("id","url","nsfwLevel","postId") VALUES ($1,$2,$3,$1)`, [
    id,
    `key-${id}`,
    nsfwLevel,
  ]);
}

/** Voters hold the rank of the stage they voted at, so that rank is staffed (they voted just now). */
async function seedVotes(
  itemId: number,
  imageId: number,
  votes: SeededVote[],
  firstPlayer: number
) {
  for (const [n, [stage, answer, weight]] of votes.entries()) {
    const playerId = firstPlayer + n;
    await pg.query(
      `INSERT INTO "NewOrderPlayer" ("userId","rankType") VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [playerId, stage]
    );
    await pg.query(
      `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","blockReason")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        itemId,
        playerId,
        new Date(NOW.getTime() - 60_000 + n * 1000),
        Q,
        imageId,
        stage,
        answer,
        weight,
        answer === '32' ? 'Other' : null,
      ]
    );
  }
}

/** The same votes twice: an Open item lapsing at its last stage (the code path), and an item already with the Inquisitors as no-consensus. */
async function pair(lastStage: string, level: number, votes: SeededVote[]) {
  await seedImage(10, level);
  await seedImage(11, level);
  const live = await enqueueItem(
    db,
    { questionKey: Q, imageId: 10, source: 'test', minRank: lastStage, expiresAt: PAST },
    NOW
  );
  const waiting = await enqueueItem(
    db,
    { questionKey: Q, imageId: 11, source: 'test', minRank: lastStage, expiresAt: null },
    NOW
  );
  await pg.query(
    `UPDATE "KnightsQueueItem" SET status='Inquisitor', "minRank"='Inquisitor', "escalationReason"='no-consensus' WHERE id=$1`,
    [waiting]
  );
  await seedVotes(live, 10, votes, 1);
  await seedVotes(waiting, 11, votes, 1);
  return { live, waiting };
}

const settledState = async (id: number) => {
  const item = (
    await pg.query<Record<string, unknown>>(
      `SELECT status, "minRank", "escalationReason", reason, "resolvedValue", "resolvedBy", "resolvedFromLevel", "appliedAt"
       FROM "KnightsQueueItem" WHERE id=$1`,
      [id]
    )
  ).rows[0];
  const votes = (
    await pg.query<{ playerId: number; verdict: string }>(
      `SELECT "playerId", verdict FROM "KnightsVote" WHERE "itemId"=$1 ORDER BY "playerId"`,
      [id]
    )
  ).rows;
  return { item, votes };
};

async function dryRun() {
  const [result] = await pg.exec(script('dry-run.sql'));
  return result.rows[0];
}

async function apply() {
  const results = await pg.exec(script('apply.sql'));
  await pg.exec('COMMIT');
  return results[results.length - 1].rows;
}

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(async () => {
  await pg.close();
});
beforeEach(async () => {
  applyConsensus.mockClear();
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","Image","Post" RESTART IDENTITY CASCADE`
  );
});

describe('backfill-no-consensus-rerate', () => {
  it('classifies rows with the same CTE in the dry run and the apply', () => {
    const sharedCte = (name: string) => {
      const text = script(name);
      const start = text.indexOf('-- shared CTE:');
      const end = text.indexOf('-- end of shared CTE');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return text.slice(start, end);
    };
    expect(sharedCte('apply.sql')).toBe(sharedCte('dry-run.sql'));
  });

  it.each([
    [
      're-rates to the most-voted level, down included',
      'Templar',
      8,
      [
        ['Knight', '8', 1],
        ['Knight', '16', 1],
        ['Templar', '2', 1],
        ['Templar', '16', 1],
        ['Templar', '2', 1],
        ['Templar', '16', 0],
      ],
      'rerate',
    ],
    [
      'breaks a tie to the highest level',
      'Paladin',
      4,
      [
        ['Templar', '2', 1],
        ['Paladin', '4', 1],
        ['Paladin', '8', 1],
      ],
      'rerate',
    ],
    [
      'sends a Blocked pick to the Inquisitors as blocked',
      'Paladin',
      4,
      [
        ['Paladin', '32', 1],
        ['Paladin', '4', 1],
        ['Paladin', '32', 1],
        ['Paladin', '8', 1],
      ],
      'blocked',
    ],
    [
      'closes a last stage below its quorum as expired',
      'Templar',
      4,
      [
        ['Knight', '4', 1],
        ['Templar', '2', 1],
        ['Templar', '4', 1],
      ],
      'expired',
    ],
    [
      'sends a Blocked pick below the quorum to the Inquisitors as blocked',
      'Templar',
      4,
      [
        ['Knight', '4', 1],
        ['Templar', '4', 1],
        ['Templar', '32', 1],
      ],
      'blocked',
    ],
  ] as const)(
    '%s, leaving the item as Knights now would',
    async (_, stage, level, votes, outcome) => {
      const { live, waiting } = await pair(stage, level, votes as unknown as SeededVote[]);
      await escalateExpired(db, { now: NOW });

      expect((await dryRun())[`to_${outcome}`]).toBe(1);
      expect(await apply()).toEqual([
        { outcome, items: 1, votes_set_aside: outcome === 'blocked' ? 0 : votes.length },
      ]);
      expect(await settledState(waiting)).toEqual(await settledState(live));
      expect(await dryRun()).toMatchObject({ to_rerate: 0, to_blocked: 0, to_expired: 0 });
    }
  );

  it('counts each outcome, leaves items not waiting as no-consensus alone, and the tick writes the re-rates back', async () => {
    await seedImage(10, 8);
    await seedImage(11, 4);
    await seedImage(12, 4);
    await seedImage(13, 4);
    await seedImage(14, 4);
    const items: number[] = [];
    for (const imageId of [10, 11, 12, 13, 14]) {
      items.push(
        await enqueueItem(db, { questionKey: Q, imageId, source: 'test', expiresAt: null }, NOW)
      );
    }
    const [rerated, blocked, expired, ruling, other] = items;
    const set = (id: number, status: string, escalationReason: string) =>
      pg.query(
        `UPDATE "KnightsQueueItem" SET status=$2, "minRank"='Inquisitor', "escalationReason"=$3 WHERE id=$1`,
        [id, status, escalationReason]
      );
    await set(rerated, 'Inquisitor', 'no-consensus');
    await set(blocked, 'Inquisitor', 'no-consensus');
    await set(expired, 'Inquisitor', 'no-consensus');
    // A moderator is ruling on it, and one the Inquisitors hold for another reason.
    await set(ruling, 'Ruling', 'no-consensus');
    await set(other, 'Inquisitor', 'pushed-down');
    const templars: SeededVote[] = [
      ['Templar', '2', 1],
      ['Templar', '2', 1],
      ['Templar', '4', 1],
    ];
    await seedVotes(rerated, 10, templars, 1);
    await seedVotes(
      blocked,
      11,
      [
        ['Paladin', '32', 1],
        ['Paladin', '4', 1],
      ],
      11
    );
    await seedVotes(expired, 12, [['Templar', '4', 1]], 21);
    await seedVotes(ruling, 13, templars, 31);
    await seedVotes(other, 14, templars, 41);

    expect(await dryRun()).toEqual({
      to_rerate: 1,
      to_blocked: 1,
      to_expired: 1,
      sample: [
        {
          id: rerated,
          imageId: 10,
          stage: 'Templar',
          pick: '2',
          stage_votes: 3,
          from_level: 8,
          outcome: 'rerate',
        },
        {
          id: blocked,
          imageId: 11,
          stage: 'Paladin',
          pick: '32',
          stage_votes: 2,
          from_level: 4,
          outcome: 'blocked',
        },
        {
          id: expired,
          imageId: 12,
          stage: 'Templar',
          pick: '4',
          stage_votes: 1,
          from_level: 4,
          outcome: 'expired',
        },
      ],
    });
    const untouched = [await settledState(ruling), await settledState(other)];

    expect(await apply()).toEqual([
      { outcome: 'blocked', items: 1, votes_set_aside: 0 },
      { outcome: 'expired', items: 1, votes_set_aside: 1 },
      { outcome: 'rerate', items: 1, votes_set_aside: 3 },
    ]);
    expect([await settledState(ruling), await settledState(other)]).toEqual(untouched);
    expect(await apply()).toEqual([]);

    expect(await applyPendingResolutions(db, { applyConsensus, now: () => NOW })).toEqual({
      applied: 1,
      failed: 0,
      rerouted: 0,
    });
    expect(applyConsensus).toHaveBeenCalledTimes(1);
    expect(applyConsensus).toHaveBeenCalledWith({
      questionKey: Q,
      imageId: 10,
      value: '2',
      actorId: 2,
    });
    const after = await settledState(rerated);
    expect(after.item).toMatchObject({ status: 'Resolved', reason: 'no-consensus-rerate' });
    expect(after.item.appliedAt).not.toBeNull();
    const settled = await pg.query<{ verdict: string; gold: number; settled: boolean }>(
      `SELECT verdict, gold, "settledAt" IS NOT NULL AS settled FROM "KnightsVote" WHERE "itemId"=$1`,
      [rerated]
    );
    expect(settled.rows).toEqual(
      Array(3).fill({ verdict: 'inconclusive', gold: 0, settled: true })
    );
  });
});
