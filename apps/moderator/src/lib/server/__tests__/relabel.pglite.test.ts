import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB as ModeratorDB } from '../moderator-db/types';
import { labelerProgress, nextCandidates, ownAnswer, saveAnswer } from '../relabel.service';
import type { Answers } from '$lib/removal-label/questions';
import { pgliteDialect } from './abuse-detection-pglite.harness';

// The hand-applied schema itself, so the two-labeler cap is tested where it is enforced.
const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '../../../../removal-label-eval/schema.sql'), 'utf8');

const answers: Answers = {
  minorPresent: 'appears_minor',
  sexualLevel: 'none',
  violence: 'none',
  schoolSetting: 'other_setting',
};

let pg: PGlite;
let db: Kysely<ModeratorDB>;

async function seedItem(imageId: number, over: Record<string, unknown> = {}): Promise<string> {
  const row = await db
    .insertInto('relabel_item')
    .values({
      batch: 'b',
      image_id: imageId,
      stratum: 'removed',
      bucket: 'animatedMinorNsfw',
      nsfw_level: 'Soft',
      stratum_key: 'animatedMinorNsfw:Soft',
      owner_id: imageId,
      ...over,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return String(row.id);
}

const save = (labelerId: number, itemId: string, a: Answers = answers) =>
  saveAnswer(db, { labelerId, itemId, answers: a, durationMs: 1000 });

// One instance for the file: PGlite takes seconds to boot, which is a hook timeout per test.
beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(SCHEMA);
  db = new Kysely<ModeratorDB>({ dialect: pgliteDialect(pg) });
}, 60_000);

beforeEach(async () => {
  await pg.exec('TRUNCATE relabel_item RESTART IDENTITY CASCADE');
});

describe('two labelers per item', () => {
  // Decision: exactly two labels per item; their agreement is the human baseline. A third would
  // silently turn a pair into a vote. The cap lives in the database trigger, not the page, because
  // two labelers racing for the last slot both pass an application-side count.
  it('refuses a third labeler and keeps the first two', async () => {
    const item = await seedItem(1);
    expect(await save(1, item)).toEqual({ ok: true });
    expect(await save(2, item)).toEqual({ ok: true });
    expect(await save(3, item)).toEqual({ ok: false, reason: 'full' });
    const rows = await db
      .selectFrom('relabel_answer')
      .select('labeler_id')
      .orderBy('labeler_id')
      .execute();
    expect(rows.map((r) => r.labeler_id)).toEqual([1, 2]);
  });

  it('lets a labeler change their own answer on a full item', async () => {
    const item = await seedItem(1);
    await save(1, item);
    await save(2, item);
    expect(await save(1, item, { ...answers, sexualLevel: 'partial_nudity' })).toEqual({
      ok: true,
    });
    expect((await ownAnswer(db, 1, item))?.answers.sexualLevel).toBe('partial_nudity');
  });

  it('reports a missing item instead of succeeding', async () => {
    expect(await save(1, '999')).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('nextCandidates', () => {
  it('skips items the labeler answered, items already full, and purged items', async () => {
    const mine = await seedItem(1);
    const full = await seedItem(2);
    const purged = await seedItem(3, { purge_after: new Date(Date.now() - 60_000) });
    const open = await seedItem(4, {
      stratum: 'not_removed',
      bucket: null,
      stratum_key: 'band1:X',
    });
    await save(9, mine);
    await save(1, full);
    await save(2, full);

    const ids = (await nextCandidates(db, 9)).map((c) => c.itemId);
    expect(ids).toEqual([open]);
    expect(ids).not.toContain(purged);
  });

  // Blinding: the queue hands the labeler an item id and an image id, nothing that says which
  // stratum the item came from or why it was removed.
  it('returns no field that would unblind the labeler', async () => {
    await seedItem(1);
    const [c] = await nextCandidates(db, 9);
    expect(Object.keys(c).sort()).toEqual(['imageId', 'itemId']);
  });

  it('orders the queue differently per labeler', async () => {
    for (let i = 1; i <= 20; i++) await seedItem(i);
    const order = async (labeler: number) =>
      (await nextCandidates(db, labeler)).map((c) => c.itemId);
    expect(await order(1)).not.toEqual(await order(2));
    expect(await order(1)).toEqual(await order(1));
  });

  it('honours skips', async () => {
    const a = await seedItem(1);
    const b = await seedItem(2);
    expect((await nextCandidates(db, 9, [a])).map((c) => c.itemId)).toEqual([b]);
  });
});

describe('model-only items', () => {
  it('are never served to a labeler and refuse an answer posted for them', async () => {
    const hidden = await seedItem(1, { relabel: false });
    const shown = await seedItem(2);
    expect((await nextCandidates(db, 9)).map((c) => c.itemId)).toEqual([shown]);
    expect(await save(9, hidden)).toEqual({ ok: false, reason: 'missing' });
    expect(await labelerProgress(db, 9)).toMatchObject({ items: 1 });
  });
});

describe('one row per image', () => {
  // Decision: daily batches overlap, so an image may be sampled again. It is stored once, or the
  // labeler sees it twice and the report counts it twice.
  it('refuses the same image in a second batch', async () => {
    await seedItem(1);
    await expect(seedItem(1, { batch: 'later' })).rejects.toThrow();
  });
});

describe('editing an answer', () => {
  it('keeps the first time-on-item, so a quick correction does not read as rubber-stamping', async () => {
    const item = await seedItem(1);
    await saveAnswer(db, { labelerId: 1, itemId: item, answers, durationMs: 40_000 });
    await saveAnswer(db, {
      labelerId: 1,
      itemId: item,
      answers: { ...answers, violence: 'graphic_gore' },
      durationMs: 3_000,
    });
    const row = await db
      .selectFrom('relabel_answer')
      .select(['duration_ms', 'violence'])
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ duration_ms: 40_000, violence: 'graphic_gore' });
  });
});

describe('labelerProgress', () => {
  it("counts the labeler's own answers and items with both labels", async () => {
    const one = await seedItem(1);
    const two = await seedItem(2);
    await save(1, one);
    await save(2, one);
    await save(1, two);
    expect(await labelerProgress(db, 1)).toEqual({ mine: 2, items: 2, complete: 1 });
  });
});
