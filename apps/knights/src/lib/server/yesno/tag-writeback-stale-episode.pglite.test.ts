import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { bootTagReview, createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { runTagReview } from './tag-review';
import { createTagReviewPort, writeBackTagReviews } from './tag-writeback';
import { castYesNoVote } from './vote';

const NOW = new Date();
const DAY_AGO = new Date(NOW.getTime() - 86_400_000).toISOString();
const LATER = new Date(NOW.getTime() + 7 * 86_400_000);
const R = 4;
const X = 16;

let pg: PGlite;
let db: Kysely<DB>;

/** The only thing faked: the HTTP call to the moderator app. */
type Call = { url: string; body: Record<string, unknown> };
let calls: Call[];
let answer: () => Response | Promise<Response>;
const fakeFetch: typeof fetch = async (url, init) => {
  calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
  return answer();
};
const ok = (outcome: string) => () => Response.json({ ok: true, result: { outcome } });
const port = (o: { endpoint?: string; token?: string } = {}) =>
  createTagReviewPort({
    endpoint: 'endpoint' in o ? o.endpoint : 'http://moderator.test',
    token: 'token' in o ? o.token : 'scoped-token',
    fetch: fakeFetch,
  });
const writeBack = (o: { at?: Date; enabled?: boolean; endpoint?: string; token?: string } = {}) =>
  writeBackTagReviews(db, port(o), { now: o.at ?? NOW, enabled: o.enabled ?? true });

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await bootTagReview(pg);
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());

beforeEach(async () => {
  calls = [];
  answer = ok('applied');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await pg.exec(`
    TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","KnightsPlayerDay","Image","Post",
      "TagsOnImageNew","Tag","CsamReport","EvidenceHeldUser","Report","ImageReport" RESTART IDENTITY CASCADE;
    DELETE FROM "KnightsQuestion" WHERE key LIKE 'knights.yesno.%';
    INSERT INTO "Tag" (id, name, type, "nsfwLevel") VALUES (10, 'nudity', 'Moderation', ${X}), (11, 'swim', 'Moderation', ${R});
  `);
  for (const id of [1, 2, 3]) await seedPlayer(pg, id, 'Paladin');
  await pg.query(
    `INSERT INTO "KnightsVote" ("itemId","playerId","createdAt","questionKey","imageId","stage","answer","weight","verdict")
     VALUES (999999, 1, $1::timestamp, 'knights.image.nsfwLevel', 0, 'Paladin', '4', 1, 'pending')`,
    [DAY_AGO]
  );
  await seedImage(pg, 100, { nsfwLevel: X, userId: 50 });
  await pg.query(`SELECT upsert_tag_on_image(100, 10, NULL, NULL, NULL, false, true)`);
  await pg.query(`SELECT upsert_tag_on_image(100, 11, NULL, NULL, false, false, false)`);
});

async function settled(answers: ('yes' | 'no')[]): Promise<number> {
  await runTagReview(db, { now: NOW, enabled: true, walk: { after: null } });
  const { rows } = await pg.query<{ id: number }>(`SELECT id FROM "KnightsQueueItem"`);
  const id = rows[0].id;
  for (const [i, a] of answers.entries())
    await castYesNoVote(db, { userId: i + 1, itemId: id, answer: a }, { now: () => NOW });
  return id;
}

const item = async (id: number) =>
  (
    await pg.query<{
      status: string;
      appliedAt: Date | null;
      reason: string | null;
      applyAttempts: number;
      nextAttemptAt: Date | null;
      meta: Record<string, unknown>;
    }>(`SELECT * FROM "KnightsQueueItem" WHERE id = $1`, [id])
  ).rows[0];

describe('a consensus a moderator already ruled over is never written back (S2)', () => {
  it('moderator keeps, tag re-flagged, stale player "remove" must not be sent', async () => {
    await pg.exec(`INSERT INTO "Tag" VALUES (12, 'x too', 'Moderation', ${X})`);
    await pg.query(`SELECT upsert_tag_on_image(100, 12, NULL, NULL, false, false, false)`);
    // The moderator app is not ready yet: the "no" consensus waits uncounted.
    answer = () => new Response('unknown action', { status: 404 });
    const id = await settled(['no', 'no']);
    expect(await writeBack()).toMatchObject({ waiting: 1 });
    calls = [];
    // A moderator rules Keep on /images/tags.
    await pg.query(`SELECT upsert_tag_on_image(100, 10, NULL, NULL, false, false, false)`);
    await runTagReview(db, { now: NOW, enabled: true, walk: { after: null } });
    expect((await item(id)).meta).toMatchObject({ episodeEnded: true });
    // Users downvote it again: re-flagged; episode 2 opens.
    await pg.query(`SELECT upsert_tag_on_image(100, 10, NULL, NULL, NULL, NULL, true)`);
    await runTagReview(db, { now: NOW, enabled: true, walk: { after: null } });
    const { rows } = await pg.query<{ externalId: string; status: string }>(
      `SELECT "externalId", status FROM "KnightsQueueItem" ORDER BY id`
    );
    expect(rows.map((r) => r.externalId)).toEqual(['mod-tag:100:10:1', 'mod-tag:100:10:2']);
    // The moderator app comes up.
    answer = ok('applied');
    await writeBack({ at: LATER });
    // Episode 1's "remove" was overruled by the moderator's Keep; it must not reach the re-flagged tag.
    expect(calls).toEqual([]);
  });
});
