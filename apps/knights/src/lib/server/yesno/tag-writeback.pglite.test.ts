import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { bootTagReview, createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { ensureVotePartitions, LEASE_MINUTES, MAX_APPLY_ATTEMPTS } from '../queue/queue.service';
import {
  answering,
  fakeModerator,
  flagTag,
  R,
  resetTagReview,
  ruleTag,
  settledItem,
  staffPaladin,
  writeBackWith,
  X,
  type WriteBackOptions,
} from './tag-review.fixtures';
import { runTagReview } from './tag-review';
import {
  createTagReviewPort,
  TAG_WRITEBACK_TIMEOUT_MS,
  writeBackTagReviews,
} from './tag-writeback';

const NOW = new Date();
const DAY_AGO = new Date(NOW.getTime() - 86_400_000);
const LATER = new Date(NOW.getTime() + 7 * 86_400_000);

let pg: PGlite;
let db: Kysely<DB>;
let moderator = fakeModerator();

const writeBack = (o: Partial<WriteBackOptions> = {}) =>
  writeBackWith(db, moderator.fetch, { ...o, at: o.at ?? NOW });
const settled = (answers: ('yes' | 'no')[]) => settledItem(db, pg, answers, NOW);

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await bootTagReview(pg);
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());

beforeEach(async () => {
  moderator = fakeModerator();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await resetTagReview(pg, [
    [10, 'nudity', 'Moderation', X],
    [11, 'swim', 'Moderation', R],
  ]);
  for (const id of [1, 2, 3]) await seedPlayer(pg, id, 'Paladin');
  await staffPaladin(pg, 1, DAY_AGO);
  await seedImage(pg, 100, { nsfwLevel: X, userId: 50 });
  await flagTag(pg, 100, 10);
  await ruleTag(pg, 100, 11, false);
});

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
    expect(moderator.state.calls).toEqual([
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
    expect(moderator.state.calls).toHaveLength(1);
  });

  it('keeps on a consensus "yes"', async () => {
    await settled(['yes', 'yes']);
    await writeBack();
    expect(moderator.state.calls[0].body).toMatchObject({
      disable: false,
      userId: 2,
      settledAtMinimum: true,
    });
  });

  it('a removal settled past the minimum says so', async () => {
    await settled(['no', 'no', 'no']);
    await writeBack();
    expect(moderator.state.calls[0].body).toMatchObject({
      disable: true,
      userId: 3,
      settledAtMinimum: false,
    });
  });

  it.each([
    ['already-ruled', true],
    ['ineligible', false],
    ['missing', false],
  ])('a %s answer is final; it ends the episode: %s', async (outcome, ends) => {
    const id = await settled(['yes', 'yes']);
    moderator.state.answer = answering(outcome);
    expect(await writeBack()).toMatchObject({ skipped: 1 });
    const after = await item(id);
    expect(after).toMatchObject({ reason: outcome, appliedAt: expect.any(Date) });
    expect(after.meta.episodeEnded === true).toBe(ends);
    await writeBack({ at: LATER });
    expect(moderator.state.calls).toHaveLength(1);
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
    moderator.state.answer = o.answer;
    expect(await writeBack()).toMatchObject({ waiting: 1 });
    expect(await item(id)).toMatchObject({ applyAttempts: 0, appliedAt: null, reason: null });
    moderator.state.answer = answering('applied');
    expect(await writeBack({ at: LATER })).toMatchObject({ applied: 1 });
  });

  it('waits without calling when the URL or token is unset', async () => {
    const id = await settled(['yes', 'yes']);
    expect(await writeBack({ endpoint: undefined })).toMatchObject({ waiting: 1 });
    expect(await writeBack({ at: LATER, token: '' })).toMatchObject({ waiting: 1 });
    expect(moderator.state.calls).toEqual([]);
    expect(await item(id)).toMatchObject({ applyAttempts: 0, appliedAt: null });
  });

  it('counts a 500 and backs off, then stops at the cap as attempts-exhausted, still Consensus', async () => {
    const id = await settled(['yes', 'yes']);
    moderator.state.answer = () => new Response('{"message":"boom"}', { status: 500 });
    expect(await writeBack()).toMatchObject({ failed: 1 });
    const first = await item(id);
    expect(first.applyAttempts).toBe(1);
    expect(first.nextAttemptAt!.getTime()).toBeGreaterThan(NOW.getTime());
    // Not due again until the backoff passes.
    await writeBack();
    expect(moderator.state.calls).toHaveLength(1);

    let at = NOW.getTime();
    for (let i = 1; i < MAX_APPLY_ATTEMPTS; i++) {
      at += 7 * 3_600_000;
      await writeBack({ at: new Date(at) });
    }
    expect(moderator.state.calls).toHaveLength(MAX_APPLY_ATTEMPTS);
    expect(await item(id)).toMatchObject({
      status: 'Consensus',
      reason: 'attempts-exhausted',
      appliedAt: null,
      applyAttempts: MAX_APPLY_ATTEMPTS,
    });
    await writeBack({ at: new Date(at + 7 * 3_600_000) });
    expect(moderator.state.calls).toHaveLength(MAX_APPLY_ATTEMPTS);
  });

  it('gives up on a call that does not answer before the lease ends, counting it as a failure', async () => {
    expect(TAG_WRITEBACK_TIMEOUT_MS).toBeLessThan(LEASE_MINUTES * 60_000);
    const id = await settled(['yes', 'yes']);
    const hanging: typeof fetch = (url, init) =>
      new Promise((_, reject) => {
        moderator.state.calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const result = await writeBackTagReviews(
      db,
      createTagReviewPort({ endpoint: 'http://m.test', token: 't', fetch: hanging, timeoutMs: 20 }),
      { now: NOW, enabled: true }
    );
    expect(result).toMatchObject({ failed: 1 });
    expect(await item(id)).toMatchObject({ applyAttempts: 1, appliedAt: null });
  });

  it('never overwrites a result another tick already recorded as applied', async () => {
    const id = await settled(['yes', 'yes']);
    let nested = false;
    moderator.state.answer = async () => {
      if (nested) return Response.json({ ok: true, result: { outcome: 'applied' } });
      nested = true;
      // While this call hangs past its lease, a later tick claims the item and applies it.
      await writeBack({ at: LATER });
      return Response.json({ ok: true, result: { outcome: 'already-ruled' } });
    };
    await writeBack();
    expect(moderator.state.calls).toHaveLength(2);
    expect(await item(id)).toMatchObject({ reason: null, appliedAt: expect.any(Date) });
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
    expect(moderator.state.calls).toEqual([]);
  });
});

describe('a consensus a moderator already ruled over is never written back (S2)', () => {
  it('moderator keeps, tag re-flagged, stale player "remove" must not be sent', async () => {
    await pg.exec(`INSERT INTO "Tag" VALUES (12, 'x too', 'Moderation', ${X})`);
    await pg.query(`SELECT upsert_tag_on_image(100, 12, NULL, NULL, false, false, false)`);
    // The moderator app is not ready yet: the "no" consensus waits uncounted.
    moderator.state.answer = () => new Response('unknown action', { status: 404 });
    const id = await settled(['no', 'no']);
    expect(await writeBack()).toMatchObject({ waiting: 1 });
    moderator.state.calls.length = 0;
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
    moderator.state.answer = answering('applied');
    await writeBack({ at: LATER });
    // Episode 1's "remove" was overruled by the moderator's Keep; it must not reach the re-flagged tag.
    expect(moderator.state.calls).toEqual([]);
  });
});
