import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { pickYesNo } from './feed';
import { importYesNo, type YesNoRow } from './import';
import { castYesNoVote } from './vote';

const NOW = new Date('2026-12-21T12:00:00Z');
const SECRET = 'test-secret';

let pg: PGlite;
let db: Kysely<DB>;
let clock = NOW;
const deps = () => ({ now: () => clock });

const row = (id: string, imageId: number, o: Partial<YesNoRow> = {}): YesNoRow => ({
  externalId: id,
  imageId,
  axis: 'violence',
  audience: 'players',
  prompt: `Question ${id}?`,
  yesEffect: 'R4',
  noEffect: 'R3',
  meta: { caseId: 'case-secret' },
  ...o,
});

async function seed(rows: YesNoRow[]) {
  for (const imageId of new Set(rows.map((r) => r.imageId)))
    await seedImage(pg, imageId, { nsfwLevel: 8 });
  await importYesNo(db, rows);
  return Object.fromEntries(
    (
      await pg.query<{ id: number; externalId: string }>(
        `SELECT id, "externalId" FROM "KnightsQueueItem"`
      )
    ).rows.map((r) => [r.externalId, r.id])
  );
}
const pick = (
  userId: number,
  o: { rank?: string; share?: number; stretch?: number; force?: boolean } = {}
) =>
  pickYesNo(db, {
    userId,
    rank: o.rank ?? 'Knight',
    secret: SECRET,
    share: o.share ?? 1,
    stretch: o.stretch ?? 8,
    force: o.force,
  });
const answer = async (userId: number, itemId: number, value = 'yes') => {
  clock = new Date(clock.getTime() + 1000);
  const result = await castYesNoVote(db, { userId, itemId, answer: value }, deps());
  expect(result).toEqual({ status: 'recorded' });
};

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  clock = NOW;
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQueueItem","NewOrderPlayer","NewOrderSmite","KnightsPlayerDay","Image","Post" RESTART IDENTITY CASCADE; DELETE FROM "KnightsQuestion" WHERE key LIKE 'knights.yesno.%'`
  );
});

describe('what a player is offered', () => {
  it('is a question about its own image, with nothing a player must not see', async () => {
    const ids = await seed([row('q-secret-id', 10)]);
    await seedPlayer(pg, 1);

    const offer = await pick(1);

    expect(offer).toMatchObject({
      itemId: ids['q-secret-id'],
      prompt: 'Question q-secret-id?',
      imageKey: 'key-10',
      banner: { heading: expect.any(String) },
    });
    const text = JSON.stringify(offer);
    for (const secret of [
      'q-secret-id"',
      'R4',
      'R3',
      'case-secret',
      'nsfwLevel',
      'externalId',
      'Effect',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('is never a policy question, an unservable image, or for a rank that cannot judge', async () => {
    await seed([row('policy', 10, { audience: 'moderators' })]);
    await seedImage(pg, 11, { publishedAt: null });
    await importYesNo(db, [row('hidden', 11)]);
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2, 'Acolyte');
    await seedPlayer(pg, 3, 'Inquisitor');

    expect(await pick(1)).toBeNull();
    await seed([row('ok', 12)]);
    expect(await pick(1)).toMatchObject({ prompt: 'Question ok?' });
    expect(await pick(2, { rank: 'Acolyte' })).toBeNull();
    expect(await pick(3, { rank: 'Inquisitor' })).toBeNull();
  });

  it('never repeats a question for a player, nor the same words about the same image under another id', async () => {
    const ids = await seed([
      row('a', 10, { prompt: 'Same?' }),
      row('b', 10, { prompt: 'Same?' }),
      row('c', 11),
    ]);
    await seedPlayer(pg, 1);

    const first = await pick(1);
    expect(first?.itemId).toBe(ids.a);
    await answer(1, ids.a);
    const second = await pick(1);
    expect(second?.itemId).toBe(ids.c);
    await answer(1, ids.c);
    expect(await pick(1)).toBeNull();
  });

  it('stops offering a question once it has a consensus, while another player still gets the rest', async () => {
    const ids = await seed([row('a', 10), row('b', 11)]);
    for (let u = 1; u <= 6; u++) await seedPlayer(pg, u);
    for (let u = 1; u <= 5; u++) await answer(u, ids.a);

    expect((await pick(6))?.itemId).toBe(ids.b);
    expect((await pick(6, { stretch: 8 }))?.itemId).toBe(ids.b);
  });

  it('finishes questions that are under way before starting new ones', async () => {
    const ids = await seed([row('a', 10), row('b', 11), row('c', 12)]);
    await seedPlayer(pg, 1);
    await seedPlayer(pg, 2);
    await answer(2, ids.c);

    expect((await pick(1))?.itemId).toBe(ids.c);
  });

  it('rolls the yes/no share per slot and is stable until the player answers', async () => {
    await seed([row('a', 10)]);
    await seedPlayer(pg, 1);
    expect(await pick(1, { share: 0 })).toBeNull();
    expect(await pick(1, { share: 0, force: true })).not.toBeNull();
    expect(await pick(1, { share: 1 })).not.toBeNull();

    const slots = new Set<boolean>();
    for (let u = 100; u < 160; u++) {
      await seedPlayer(pg, u);
      slots.add((await pick(u, { share: 0.5 })) !== null);
    }
    expect(slots).toEqual(new Set([true, false]));
    expect(await pick(100, { share: 0.5 })).toEqual(await pick(100, { share: 0.5 }));
  });
});

describe('stretches', () => {
  it('stays on one axis for a stretch with a banner on its first question only, then moves to the next axis with a new banner', async () => {
    await seed([
      row('v1', 10, { axis: 'violence' }),
      row('v2', 11, { axis: 'violence' }),
      row('v3', 12, { axis: 'violence' }),
      row('l1', 13, { axis: 'language' }),
      row('l2', 14, { axis: 'language' }),
    ]);
    await seedPlayer(pg, 1);

    const seen: { prompt: string; banner: boolean }[] = [];
    for (let i = 0; i < 5; i++) {
      const offer = await pick(1, { stretch: 2 });
      expect(offer).not.toBeNull();
      seen.push({ prompt: offer!.prompt, banner: offer!.banner !== null });
      await answer(1, offer!.itemId);
    }

    // The language axis sorts first, so the stretches are language, language, violence, violence, then violence continues without a banner.
    expect(seen.map((s) => s.prompt)).toEqual([
      'Question l1?',
      'Question l2?',
      'Question v1?',
      'Question v2?',
      'Question v3?',
    ]);
    expect(seen.map((s) => s.banner)).toEqual([true, false, true, false, false]);
    expect(await pick(1, { stretch: 2 })).toBeNull();
  });
});
