import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { bootTagReview, createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { ensureVotePartitions, MAX_APPLY_ATTEMPTS } from '../queue/queue.service';
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

describe('writing a tag review consensus back', () => {
  it('removes on a consensus "no", as the closing player, settled on the minimum', async () => {
    // A level-neutral removal settles 2-0: tag 11 is lower, so make it level-neutral with another X tag.
    await pg.exec(`INSERT INTO "Tag" VALUES (12, 'x too', 'Moderation', ${X})`);
    await pg.query(`SELECT upsert_tag_on_image(100, 12, NULL, NULL, false, false, false)`);
    const id = await settled(['no', 'no']);
    expect((await item(id)).status).toBe('Consensus');

    expect(await writeBack()).toMatchObject({ applied: 1 });
    expect(calls).toEqual([
      {
        url: 'http://moderator.test/api/mod/image-tag-moderate',
        body: { imageId: 100, tagId: 10, disable: true, userId: 2, settledAtMinimum: true },
      },
    ]);
    expect(await item(id)).toMatchObject({
      status: 'Consensus',
      reason: null,
      appliedAt: expect.any(Date),
      meta: { tagId: 10, episode: 1, episodeEnded: true },
    });
    await writeBack();
    expect(calls).toHaveLength(1);
  });

  it('keeps on a consensus "yes"', async () => {
    await settled(['yes', 'yes']);
    await writeBack();
    expect(calls[0].body).toMatchObject({ disable: false, userId: 2, settledAtMinimum: true });
  });

  it('a removal settled past the minimum says so', async () => {
    await settled(['no', 'no', 'no']);
    await writeBack();
    expect(calls[0].body).toMatchObject({ disable: true, userId: 3, settledAtMinimum: false });
  });

  it.each([
    ['already-ruled', true],
    ['ineligible', false],
    ['missing', false],
  ])('a %s answer is final; it ends the episode: %s', async (outcome, ends) => {
    const id = await settled(['yes', 'yes']);
    answer = ok(outcome);
    expect(await writeBack()).toMatchObject({ skipped: 1 });
    const after = await item(id);
    expect(after).toMatchObject({ reason: outcome, appliedAt: expect.any(Date) });
    expect(after.meta.episodeEnded === true).toBe(ends);
    await writeBack({ at: LATER });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['a 404 (no such action yet)', { answer: () => new Response('{}', { status: 404 }) }],
    ['a 401 (credential not accepted yet)', { answer: () => new Response('{}', { status: 401 }) }],
    [
      'a refused connection',
      {
        answer: () => {
          throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        },
      },
    ],
  ])('waits without spending an attempt on %s, and is retried', async (_, o) => {
    const id = await settled(['yes', 'yes']);
    answer = o.answer;
    expect(await writeBack()).toMatchObject({ waiting: 1 });
    expect(await item(id)).toMatchObject({ applyAttempts: 0, appliedAt: null, reason: null });
    answer = ok('applied');
    expect(await writeBack({ at: LATER })).toMatchObject({ applied: 1 });
  });

  it('waits without calling when the URL or token is unset', async () => {
    const id = await settled(['yes', 'yes']);
    expect(await writeBack({ endpoint: undefined })).toMatchObject({ waiting: 1 });
    expect(await writeBack({ at: LATER, token: '' })).toMatchObject({ waiting: 1 });
    expect(calls).toEqual([]);
    expect(await item(id)).toMatchObject({ applyAttempts: 0, appliedAt: null });
  });

  it('counts a 500 and backs off, then stops at the cap as attempts-exhausted, still Consensus', async () => {
    const id = await settled(['yes', 'yes']);
    answer = () => new Response('{"message":"boom"}', { status: 500 });
    expect(await writeBack()).toMatchObject({ failed: 1 });
    const first = await item(id);
    expect(first.applyAttempts).toBe(1);
    expect(first.nextAttemptAt!.getTime()).toBeGreaterThan(NOW.getTime());
    // Not due again until the backoff passes.
    await writeBack();
    expect(calls).toHaveLength(1);

    let at = NOW.getTime();
    for (let i = 1; i < MAX_APPLY_ATTEMPTS; i++) {
      at += 7 * 3_600_000;
      await writeBack({ at: new Date(at) });
    }
    expect(calls).toHaveLength(MAX_APPLY_ATTEMPTS);
    expect(await item(id)).toMatchObject({
      status: 'Consensus',
      reason: 'attempts-exhausted',
      appliedAt: null,
      applyAttempts: MAX_APPLY_ATTEMPTS,
    });
    await writeBack({ at: new Date(at + 7 * 3_600_000) });
    expect(calls).toHaveLength(MAX_APPLY_ATTEMPTS);
  });

  it('makes no call with the switch off', async () => {
    await settled(['yes', 'yes']);
    expect(await writeBack({ enabled: false })).toEqual({
      applied: 0,
      skipped: 0,
      waiting: 0,
      failed: 0,
      exhausted: 0,
    });
    expect(calls).toEqual([]);
  });
});
