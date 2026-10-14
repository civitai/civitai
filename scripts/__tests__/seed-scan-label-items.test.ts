import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseExpectedIds, parseSeed, seed, type SeedRow } from '../oneoffs/seed-scan-label-items';

const MIGRATION = readFileSync(
  path.join(
    __dirname,
    '../../packages/civitai-db-schema/prisma/migrations/20261022130000_scan_label_queue/migration.sql'
  ),
  'utf8'
);

const row = (imageId: number, over: Partial<SeedRow> = {}): SeedRow => ({
  imageId,
  workflowId: `wf-${imageId}`,
  flaggedAt: '2026-10-12T21:00:00.000Z',
  reason: 'refused',
  snapshot: { nsfwLevel: 'x' },
  ...over,
});

let pg: PGlite;
beforeEach(async () => {
  pg = await PGlite.create();
  await pg.exec(`CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY)`);
  await pg.exec(MIGRATION);
  await pg.exec(`INSERT INTO "Image" VALUES (1), (2), (3)`);
});

describe('parseSeed', () => {
  it('reads one object per line and refuses duplicates', () => {
    const line = (r: SeedRow) => JSON.stringify(r);
    expect(parseSeed(`${line(row(1))}\n\n${line(row(2))}\n`)).toHaveLength(2);
    expect(() => parseSeed(`${line(row(1))}\n${line(row(1, { workflowId: 'other' }))}`)).toThrow(
      /duplicate imageId/
    );
    expect(() => parseSeed(`${line(row(1))}\n${line(row(2, { workflowId: 'wf-1' }))}`)).toThrow(
      /duplicate workflowId/
    );
    expect(() => parseSeed(JSON.stringify({ ...row(1), flaggedAt: 'soon' }))).toThrow(/flaggedAt/);
  });
});

describe('parseExpectedIds', () => {
  it('takes the ids from the last backtick span only', () => {
    expect(parseExpectedIds('see `2026-10-13_x.sql`\n\n## Open ids (2)\n\n`11,22`\n')).toEqual([
      11, 22,
    ]);
  });
});

describe('seed', () => {
  it('inserts an open item and a flag per existing image, and skips deleted images', async () => {
    const report = await seed(pg, [row(1), row(2), row(99)], { flaggerVersion: 'scan@1' });
    expect(report).toEqual({ rows: 3, missingImages: [99], itemsInserted: 2, flagsInserted: 2 });
    const { rows } = await pg.query<{ imageId: number; status: string; snapshot: unknown }>(
      `SELECT i."imageId", i.status, f.snapshot FROM "ScanLabelItem" i JOIN "ScanLabelFlag" f ON f."itemId" = i.id ORDER BY 1`
    );
    expect(rows).toEqual([
      { imageId: 1, status: 'open', snapshot: { nsfwLevel: 'x' } },
      { imageId: 2, status: 'open', snapshot: { nsfwLevel: 'x' } },
    ]);
  });

  it('is a no-op the second time', async () => {
    await seed(pg, [row(1)], { flaggerVersion: 'scan@1' });
    expect(await seed(pg, [row(1)], { flaggerVersion: 'scan@1' })).toMatchObject({
      itemsInserted: 0,
      flagsInserted: 0,
    });
  });

  it('refuses a seed missing an expected id whose image still exists', async () => {
    await expect(seed(pg, [row(1)], { flaggerVersion: 'v', expectedIds: [1, 2] })).rejects.toThrow(
      /1 expected ids are missing/
    );
    const { rows } = await pg.query(`SELECT 1 FROM "ScanLabelItem"`);
    expect(rows).toHaveLength(0);
  });

  it('accepts a seed missing an expected id whose image is gone', async () => {
    const report = await seed(pg, [row(1)], { flaggerVersion: 'v', expectedIds: [1, 98] });
    expect(report.itemsInserted).toBe(1);
  });

  it('never moves a decided item or its votes', async () => {
    await seed(pg, [row(1)], { flaggerVersion: 'v' });
    await pg.exec(`UPDATE "ScanLabelItem" SET status = 'decided', votes = 3, "blockVotes" = 2`);
    await seed(pg, [row(1, { workflowId: 'wf-rescan', flaggedAt: '2026-10-01T00:00:00Z' })], {
      flaggerVersion: 'v',
    });
    const { rows } = await pg.query(`SELECT status, votes, "firstFlaggedAt" FROM "ScanLabelItem"`);
    expect(rows).toEqual([
      { status: 'decided', votes: 3, firstFlaggedAt: new Date('2026-10-01T00:00:00Z') },
    ]);
  });
});
