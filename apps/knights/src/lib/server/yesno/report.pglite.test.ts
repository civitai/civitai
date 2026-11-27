import type { PGlite } from '@electric-sql/pglite';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@civitai/db-schema/kysely';
import { createQueueDb } from '../../../test/pglite-kysely';
import { seedImage, seedPlayer } from '../../../test/seed';
import { ensureVotePartitions } from '../queue/queue.service';
import { pickYesNo } from './feed';
import { importYesNo, type YesNoRow } from './import';
import { fileOpenImagePulls, recordReport, reportYesNo, type FileImageReport } from './report';
import { closeStrandedYesNo } from './sweep';
import { castYesNoVote } from './vote';

const NOW = new Date('2026-12-21T12:00:00Z');
const THRESHOLD = 5;
const IMAGE = 500;
const OTHER_IMAGE = 501;

let pg: PGlite;
let db: Kysely<DB>;
let ids: Record<string, number>;
let fileReport: ReturnType<typeof vi.fn<FileImageReport>>;

const row = (id: string, imageId: number, prompt: string): YesNoRow => ({
  externalId: id,
  imageId,
  axis: 'violence',
  audience: 'players',
  prompt,
  yesEffect: 'R4',
  noEffect: 'R3',
  meta: {},
});

const report = (playerId: number, item: string, reason: 'image' | 'question') =>
  reportYesNo(db, { playerId, itemId: ids[item], reason, now: NOW }, async () => ({
    threshold: THRESHOLD,
    fileReport,
  }));

/** One distinct player per reason, numbered from `from`, reports `item`. */
async function reportBy(item: string, reasons: ('image' | 'question')[], from = 100) {
  for (const [index, reason] of reasons.entries()) await report(from + index, item, reason);
}

const dealt = async (userId: number) =>
  (await pickYesNo(db, { userId, rank: 'Knight', secret: 's', share: 1, stretch: 8, force: true }))
    ?.itemId ?? null;

/** Every question a fresh player is dealt, in turn, as external ids. */
async function dealtToFresh(userId = 900) {
  const seen: string[] = [];
  const exclude: number[] = [];
  for (;;) {
    const offer = await pickYesNo(db, {
      userId,
      rank: 'Knight',
      secret: 's',
      share: 1,
      stretch: 8,
      force: true,
      exclude,
    });
    if (!offer) return seen;
    exclude.push(offer.itemId);
    seen.push(Object.entries(ids).find(([, id]) => id === offer.itemId)![0]);
  }
}

const statusOf = async (item: string) =>
  (
    await pg.query<{ status: string }>(`SELECT status FROM "KnightsQueueItem" WHERE id = $1`, [
      ids[item],
    ])
  ).rows[0].status;

const pulls = async () =>
  (
    await pg.query<{ imageId: number; reportId: number | null; resolvedAt: Date | null }>(
      `SELECT "imageId", "reportId", "resolvedAt" FROM "KnightsImagePull" ORDER BY id`
    )
  ).rows;

beforeAll(async () => {
  ({ pg, db } = await createQueueDb());
  await ensureVotePartitions(db, { now: NOW, monthsAhead: 1 });
});
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec(
    `TRUNCATE "KnightsVote","KnightsQuestionReport","KnightsImagePull","KnightsQueueItem","NewOrderPlayer","Image","Post" RESTART IDENTITY CASCADE; DELETE FROM "KnightsQuestion" WHERE key LIKE 'knights.yesno.%'`
  );
  await seedImage(pg, IMAGE, { nsfwLevel: 8 });
  await seedImage(pg, OTHER_IMAGE, { nsfwLevel: 8 });
  await importYesNo(db, [
    row('a', IMAGE, 'Is there blood?'),
    row('b', IMAGE, 'Is a weapon shown?'),
    row('c', OTHER_IMAGE, 'Is anyone hurt?'),
  ]);
  ids = Object.fromEntries(
    (
      await pg.query<{ id: number; externalId: string }>(
        `SELECT id, "externalId" FROM "KnightsQueueItem"`
      )
    ).rows.map((r) => [r.externalId, r.id])
  );
  fileReport = vi.fn<FileImageReport>().mockResolvedValue(77);
});

describe('a report below the threshold', () => {
  it('stops the reporter being dealt the question at once, and nobody else', async () => {
    expect(await dealt(1)).toBe(ids.a);
    await report(1, 'a', 'question');

    expect(await dealt(1)).toBe(ids.b);
    expect(await dealt(2)).toBe(ids.a);
    expect(await statusOf('a')).toBe('Open');
  });

  it('pulls nothing at four distinct reporters', async () => {
    await reportBy('a', ['image', 'image', 'image', 'image']);

    expect(await statusOf('a')).toBe('Open');
    expect(await dealtToFresh()).toEqual(['a', 'b', 'c']);
    expect(await pulls()).toEqual([]);
    expect(fileReport).not.toHaveBeenCalled();
  });

  it('counts a repeat report from the same player once', async () => {
    for (let i = 0; i < THRESHOLD; i++)
      expect((await report(1, 'a', 'question')).recorded).toBe(i === 0);
    await reportBy('a', ['question', 'question', 'question']);

    expect(await statusOf('a')).toBe('Open');
  });
});

describe('the fifth distinct reporter', () => {
  it('pulls the question for everyone: Reported, dealt to nobody, refused to a vote', async () => {
    await seedPlayer(pg, 900);
    await reportBy('a', ['question', 'question', 'question', 'question']);
    expect((await report(104, 'a', 'question')).pulled).toBe(true);

    expect(await statusOf('a')).toBe('Reported');
    expect(await dealtToFresh()).toEqual(['b', 'c']);
    expect(
      await castYesNoVote(db, { userId: 900, itemId: ids.a, answer: 'yes' }, { now: () => NOW })
    ).toEqual({ status: 'rejected', reason: 'not-open' });
  });

  it('on a question reason files nothing and pulls only that question', async () => {
    await reportBy('a', ['question', 'question', 'image', 'image', 'question']);

    expect(await statusOf('a')).toBe('Reported');
    expect(fileReport).not.toHaveBeenCalled();
    expect(await pulls()).toEqual([]);
    expect(await dealtToFresh()).toEqual(['b', 'c']);
  });

  it('on an image reason pulls the image from every question and files one main-app report', async () => {
    await reportBy('a', ['image', 'question', 'image', 'question', 'image']);

    expect(await statusOf('a')).toBe('Reported');
    expect(fileReport).toHaveBeenCalledTimes(1);
    expect(fileReport).toHaveBeenCalledWith(IMAGE);
    expect(await pulls()).toEqual([{ imageId: IMAGE, reportId: 77, resolvedAt: null }]);
    expect(await statusOf('b')).toBe('Open');
    expect(await dealtToFresh()).toEqual(['c']);
  });

  it('files nothing on a second pull of the same image', async () => {
    await reportBy('a', ['image', 'image', 'image', 'image', 'image']);
    await reportBy('b', ['image', 'image', 'image', 'image', 'image'], 200);

    expect(await statusOf('b')).toBe('Reported');
    expect(fileReport).toHaveBeenCalledTimes(1);
    expect(await pulls()).toEqual([{ imageId: IMAGE, reportId: 77, resolvedAt: null }]);
  });

  it('still holds the image when the filing fails, and the tick files it later', async () => {
    fileReport.mockRejectedValueOnce(new Error('main app down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reportBy('a', ['image', 'image', 'image', 'image', 'image']);

    expect(await pulls()).toEqual([{ imageId: IMAGE, reportId: null, resolvedAt: null }]);
    expect(await dealtToFresh()).toEqual(['c']);
    expect(logged).toHaveBeenCalledWith(
      'knights: could not file the main-app report for a pulled image',
      expect.objectContaining({ imageId: IMAGE })
    );
    logged.mockRestore();

    expect(await fileOpenImagePulls(db, fileReport)).toEqual({ filed: 1, failed: 0 });
    expect(fileReport).toHaveBeenCalledTimes(2);
    expect(await pulls()).toEqual([{ imageId: IMAGE, reportId: 77, resolvedAt: null }]);
    expect(await fileOpenImagePulls(db, fileReport)).toEqual({ filed: 0, failed: 0 });
    expect(fileReport).toHaveBeenCalledTimes(2);
  });
});

describe('what takes no report', () => {
  it('a question that is not open, or a tag review item', async () => {
    await pg.query(`UPDATE "KnightsQueueItem" SET status = 'Closed' WHERE id = $1`, [ids.a]);
    await pg.query(`UPDATE "KnightsQueueItem" SET source = 'mod-tag-review' WHERE id = $1`, [
      ids.c,
    ]);
    const input = { playerId: 1, reason: 'question' as const, now: NOW };

    expect(await recordReport(db, { ...input, itemId: ids.a }, 1)).toMatchObject({
      recorded: false,
    });
    expect(await recordReport(db, { ...input, itemId: ids.c }, 1)).toMatchObject({
      recorded: false,
    });
    expect((await pg.query(`SELECT 1 FROM "KnightsQuestionReport"`)).rows).toHaveLength(0);
  });

  it('never throws: a store that fails is logged and reported as not recorded', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      transaction: () => {
        throw new Error('permission denied for table KnightsQuestionReport');
      },
    } as unknown as Kysely<DB>;
    expect(
      await reportYesNo(
        broken,
        { playerId: 1, itemId: ids.a, reason: 'image', now: NOW },
        async () => ({
          threshold: THRESHOLD,
          fileReport,
        })
      )
    ).toEqual({ recorded: false, pulled: false, pulledImage: null });
    logged.mockRestore();
  });
});

describe('the tick on reported questions', () => {
  it('neither sweeps a Reported question nor closes the other questions on a pulled image', async () => {
    for (const player of [1, 2]) await seedPlayer(pg, player);
    await castYesNoVote(db, { userId: 1, itemId: ids.a, answer: 'yes' }, { now: () => NOW });
    await castYesNoVote(db, { userId: 2, itemId: ids.b, answer: 'yes' }, { now: () => NOW });
    await reportBy('a', ['image', 'image', 'image', 'image', 'image']);

    const later = new Date(NOW.getTime() + 86_400_000);
    expect(await closeStrandedYesNo(db, { now: later, maxAgeDays: 30 })).toEqual({
      unplayable: 0,
      stale: 0,
      failed: 0,
    });
    expect(await statusOf('a')).toBe('Reported');
    expect(await statusOf('b')).toBe('Open');
  });
});
