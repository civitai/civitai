import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const state = vi.hoisted(() => ({ db: null as unknown as Kysely<DB> }));
vi.mock('$lib/server/db', () => ({
  get dbWrite() {
    return state.db;
  },
}));
import { audioSampleBatch, getAudioReviews, recordAudioReview } from '../audio-review.service';
import { GET as exportSample } from '../../../routes/audio-review/export/+server';

let pg: PGlite;
beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(`
    SET TIME ZONE 'UTC';
    CREATE TYPE "EntityModerationStatus" AS ENUM ('Pending','Succeeded','Failed','Expired','Canceled');
    CREATE TABLE "User" (id INTEGER PRIMARY KEY);
    CREATE TABLE "Image" (id SERIAL PRIMARY KEY, url TEXT NOT NULL, type TEXT NOT NULL,
      ingestion TEXT NOT NULL DEFAULT 'Scanned', "nsfwLevel" INTEGER NOT NULL DEFAULT 1);
    INSERT INTO "User" VALUES (1);
  `);
  await pg.exec(
    readFileSync(
      new URL(
        '../../../../../../packages/civitai-db-schema/prisma/migrations/20261014190000_audio_moderation_shadow/migration.sql',
        import.meta.url
      ),
      'utf8'
    )
  );
  state.db = new Kysely<DB>({ dialect: pgliteDialect(pg) });
});
afterAll(async () => {
  await state.db?.destroy();
  await pg?.close();
});
beforeEach(async () => {
  await pg.exec('TRUNCATE "AudioModerationScan", "Image" CASCADE');
});

async function upload(type = 'video') {
  const { rows } = await pg.query<{ id: number }>(
    'INSERT INTO "Image" (url, type) VALUES ($1, $2) RETURNING id',
    ['media-url', type]
  );
  return rows[0].id;
}

const verdict = {
  lyrics: 'A test transcript.',
  sexualizedMinors: true,
  blocked: true,
  hasAudio: true,
  score: 0.9,
  model: 'test-model',
  policyHash: 'test-policy',
};

describe('posted audio shadow review', () => {
  it('atomically queues video and music, excludes images, and deduplicates repeated ingestion', async () => {
    await upload('video');
    await upload('audio');
    await upload('image');
    await pg.exec('UPDATE "Image" SET url = url');
    expect(await state.db.selectFrom('AudioModerationScan').selectAll().execute()).toHaveLength(2);
    await pg.exec(
      "BEGIN; INSERT INTO \"Image\" (url,type) VALUES ('rolled-back','video'); ROLLBACK;"
    );
    expect(await state.db.selectFrom('AudioModerationScan').selectAll().execute()).toHaveLength(2);
  });

  it('records one moderator verdict without changing publication, and exports both labels', async () => {
    const imageId = await upload();
    await state.db
      .updateTable('AudioModerationScan')
      .set({ status: 'Succeeded', flagged: true, result: verdict, completedAt: new Date() })
      .execute();
    const queue = await getAudioReviews('flagged');
    expect(queue.rows).toHaveLength(1);
    const scan = queue.rows[0];
    const review = {
      id: scan.id,
      sourceHash: scan.sourceHash,
      wouldBlock: false,
      notes: 'False positive',
      reviewerId: 1,
    };
    expect(await recordAudioReview(review)).toBe(true);
    expect(await recordAudioReview({ ...review, wouldBlock: true })).toBe(false);
    expect((await getAudioReviews('flagged')).rows).toHaveLength(0);
    expect((await getAudioReviews('reviewed')).rows[0].wouldBlock).toBe(false);
    expect(
      (await pg.query('SELECT ingestion, "nsfwLevel" FROM "Image" WHERE id=$1', [imageId])).rows
    ).toEqual([{ ingestion: 'Scanned', nsfwLevel: 1 }]);
    const from = new Date(Date.now() - 14 * 86400_000);
    const to = new Date(Date.now() + 1000);
    expect((await audioSampleBatch(from, to, 0))[0]).toMatchObject({
      flagged: true,
      wouldBlock: false,
      reviewerId: 1,
    });
    const response = await exportSample({} as Parameters<typeof exportSample>[0]);
    const exported = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(exported.at(-1)).toEqual({
      type: 'summary',
      complete: true,
      groups: [{ status: 'Succeeded', flagged: true, wouldBlock: false, count: 1 }],
    });
  });

  it('refuses a review after media replacement and keeps the earlier evidence', async () => {
    const imageId = await upload();
    await state.db
      .updateTable('AudioModerationScan')
      .set({ status: 'Succeeded', flagged: true, result: verdict })
      .execute();
    const scan = (await getAudioReviews('flagged')).rows[0];
    await pg.query('UPDATE "Image" SET url=$1 WHERE id=$2', ['replacement', imageId]);
    expect(
      await recordAudioReview({
        id: scan.id,
        sourceHash: scan.sourceHash,
        wouldBlock: true,
        notes: '',
        reviewerId: 1,
      })
    ).toBe(false);
    expect((await getAudioReviews('all')).rows).toHaveLength(1);
    expect(await state.db.selectFrom('AudioModerationScan').selectAll().execute()).toHaveLength(2);
  });

  it('keeps errors and no-audio skips in the sample without presenting either as an allowed verdict', async () => {
    await upload();
    await upload('audio');
    const scans = await state.db
      .selectFrom('AudioModerationScan')
      .selectAll()
      .orderBy('id')
      .execute();
    await state.db
      .updateTable('AudioModerationScan')
      .set({
        status: 'Succeeded',
        result: {
          lyrics: '',
          sexualizedMinors: false,
          blocked: false,
          hasAudio: false,
          skippedReason: 'noAudioTrack',
        },
      })
      .where('id', '=', scans[0].id)
      .execute();
    await state.db
      .updateTable('AudioModerationScan')
      .set({ status: 'Failed', error: 'transcription failed' })
      .where('id', '=', scans[1].id)
      .execute();
    expect((await getAudioReviews('failed')).rows).toHaveLength(1);
    expect((await getAudioReviews('flagged')).rows).toHaveLength(0);
    expect(
      await recordAudioReview({
        id: scans[0].id,
        sourceHash: scans[0].sourceHash,
        wouldBlock: false,
        notes: '',
        reviewerId: 1,
      })
    ).toBe(false);
    expect(await audioSampleBatch(new Date(0), new Date(Date.now() + 1000), 0)).toHaveLength(2);
  });

  it('retains verdicts after deletion while redacting source content and canceling unfinished scans', async () => {
    await upload();
    await upload('audio');
    const scans = await state.db
      .selectFrom('AudioModerationScan')
      .selectAll()
      .orderBy('id')
      .execute();
    await state.db
      .updateTable('AudioModerationScan')
      .set({
        status: 'Succeeded',
        flagged: true,
        result: verdict,
        wouldBlock: false,
        reviewerId: 1,
        reviewedAt: new Date(),
      })
      .where('id', '=', scans[0].id)
      .execute();
    await pg.exec('DELETE FROM "Image"');
    const rows = await state.db
      .selectFrom('AudioModerationScan')
      .selectAll()
      .orderBy('id')
      .execute();
    expect(rows[0]).toMatchObject({
      imageId: null,
      sourceUrl: '',
      status: 'Succeeded',
      flagged: true,
      wouldBlock: false,
    });
    expect(rows[0].sourceDeletedAt).not.toBeNull();
    expect(rows[0].result).not.toHaveProperty('lyrics');
    expect(rows[1]).toMatchObject({ imageId: null, sourceUrl: '', status: 'Canceled' });
    expect((await getAudioReviews('all')).rows).toHaveLength(0);
  });
});
