import { beforeEach, describe, expect, it } from 'vitest';
import {
  countScannerLabelReviewsByUser,
  getScannerContentImages,
  getScannerContentSnapshots,
  getScannerLabelReviewStats,
  getScannerLabelReviewVerdicts,
  getScannerLabelReviewsByUser,
  insertScannerContentSnapshot,
  upsertScannerLabelVerdict,
} from './scanner.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('getScannerLabelReviewStats', () => {
  it('joins reviews to snapshots, filters by scanner, and tallies verdicts by label', async () => {
    await getScannerLabelReviewStats(harness.db, { scanner: 'xguard_text' });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('FROM "ScannerLabelReview" r');
    expect(sql).toContain('JOIN "ScannerContentSnapshot" s ON s."contentHash" = r."contentHash"');
    expect(sql).toContain(`COUNT(*) FILTER (WHERE r."verdict" = 'TruePositive') AS "truePositive"`);
    expect(sql).toContain(
      `COUNT(*) FILTER (WHERE r."verdict" = 'FalsePositive') AS "falsePositive"`
    );
    expect(sql).toContain(`COUNT(*) FILTER (WHERE r."verdict" = 'TrueNegative') AS "trueNegative"`);
    expect(sql).toContain(
      `COUNT(*) FILTER (WHERE r."verdict" = 'FalseNegative') AS "falseNegative"`
    );
    expect(sql).toContain(`COUNT(*) FILTER (WHERE r."verdict" = 'Unsure') AS unsure`);
    expect(sql).toContain('WHERE s."scanner" = $1');
    expect(sql).toContain('GROUP BY r."label"');
    expect(parameters).toEqual(['xguard_text']);
  });
});

describe('getScannerLabelReviewVerdicts', () => {
  it('short-circuits an empty key list WITHOUT running a query (no OR ())', async () => {
    const result = await getScannerLabelReviewVerdicts(harness.db, []);
    expect(result).toEqual([]);
    expect(harness.queries).toHaveLength(0);
  });

  it('builds an OR of per-key (contentHash, version, label) conjunctions', async () => {
    await getScannerLabelReviewVerdicts(harness.db, [
      { contentHash: 'h1', version: 'v1', label: 'l1' },
      { contentHash: 'h2', version: 'v2', label: 'l2' },
    ]);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('select "contentHash", "version", "label", "reviewedBy", "verdict"');
    expect(sql).toContain('from "ScannerLabelReview"');
    expect(sql).toContain(
      '(("contentHash" = $1 and "version" = $2 and "label" = $3) or ' +
        '("contentHash" = $4 and "version" = $5 and "label" = $6))'
    );
    expect(parameters).toEqual(['h1', 'v1', 'l1', 'h2', 'v2', 'l2']);
  });
});

describe('countScannerLabelReviewsByUser', () => {
  it('counts a reviewer’s verdicts for one label since a cutoff', async () => {
    const since = new Date('2026-07-01T00:00:00Z');
    await countScannerLabelReviewsByUser(harness.db, { userId: 42, label: 'nudity', since });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select count(*) as "count" from "ScannerLabelReview" ' +
        'where "reviewedBy" = $1 and "label" = $2 and "reviewedAt" > $3'
    );
    expect(parameters).toEqual([42, 'nudity', since]);
  });
});

describe('getScannerLabelReviewsByUser', () => {
  it('short-circuits an empty contentHash list WITHOUT running a query (no IN ())', async () => {
    const result = await getScannerLabelReviewsByUser(harness.db, {
      userId: 1,
      label: 'l',
      contentHashes: [],
    });
    expect(result).toEqual([]);
    expect(harness.queries).toHaveLength(0);
  });

  it('selects reviewed keys for a user+label within a candidate hash set', async () => {
    await getScannerLabelReviewsByUser(harness.db, {
      userId: 42,
      label: 'nudity',
      contentHashes: ['h1', 'h2'],
    });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "contentHash", "version" from "ScannerLabelReview" ' +
        'where "reviewedBy" = $1 and "label" = $2 and "contentHash" in ($3, $4)'
    );
    expect(sql).not.toContain('in ()');
    expect(parameters).toEqual([42, 'nudity', 'h1', 'h2']);
  });
});

describe('upsertScannerLabelVerdict', () => {
  it('inserts a verdict and re-stamps verdict/note/reviewedAt on conflict', async () => {
    await upsertScannerLabelVerdict(harness.db, {
      contentHash: 'h1',
      version: 'v1',
      label: 'nudity',
      verdict: 'TruePositive',
      note: 'clear',
      userId: 42,
    });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'insert into "ScannerLabelReview" ' +
        '("contentHash", "version", "label", "reviewedBy", "verdict", "note") ' +
        'values ($1, $2, $3, $4, $5, $6) ' +
        'on conflict ("contentHash", "version", "label", "reviewedBy") ' +
        'do update set "verdict" = $7, "note" = $8, "reviewedAt" = $9'
    );
    expect(parameters.slice(0, 6)).toEqual(['h1', 'v1', 'nudity', 42, 'TruePositive', 'clear']);
    expect(parameters[6]).toBe('TruePositive');
    expect(parameters[7]).toBe('clear');
    expect(parameters[8]).toBeInstanceOf(Date);
  });

  it('defaults an absent note to null', async () => {
    await upsertScannerLabelVerdict(harness.db, {
      contentHash: 'h1',
      version: 'v1',
      label: 'nudity',
      verdict: 'Unsure',
      userId: 42,
    });
    const { parameters } = harness.lastQuery();
    expect(parameters[5]).toBeNull();
    expect(parameters[7]).toBeNull();
  });
});

describe('insertScannerContentSnapshot', () => {
  it('writes the compacted body as jsonb with first-writer-wins onConflict', async () => {
    await insertScannerContentSnapshot(harness.db, {
      contentHash: 'h1',
      scanner: 'xguard_text',
      body: { text: 'hi', labelReasons: {}, imageId: undefined },
    });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'insert into "ScannerContentSnapshot" ("contentHash", "scanner", "content") ' +
        'values ($1, $2, $3::jsonb) on conflict ("contentHash") do nothing'
    );
    expect(parameters[0]).toBe('h1');
    expect(parameters[1]).toBe('xguard_text');
    // Nulls/undefined and empty arrays stripped; labelReasons={} is an object (kept).
    expect(JSON.parse(parameters[2] as string)).toEqual({ text: 'hi', labelReasons: {} });
  });

  it('strips empty arrays but keeps 0/false/empty-string values', async () => {
    await insertScannerContentSnapshot(harness.db, {
      contentHash: 'h1',
      scanner: 's',
      body: { text: '', userId: 0, labelReasons: undefined } as never,
    });
    const { parameters } = harness.lastQuery();
    expect(JSON.parse(parameters[2] as string)).toEqual({ text: '', userId: 0 });
  });
});

describe('getScannerContentSnapshots', () => {
  it('short-circuits an empty batch WITHOUT running a query', async () => {
    const result = await getScannerContentSnapshots(harness.db, []);
    expect(result).toEqual([]);
    expect(harness.queries).toHaveLength(0);
  });

  it('selects snapshots for a batch of content hashes', async () => {
    await getScannerContentSnapshots(harness.db, ['h1', 'h2']);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "contentHash", "scanner", "content" from "ScannerContentSnapshot" ' +
        'where "contentHash" in ($1, $2)'
    );
    expect(parameters).toEqual(['h1', 'h2']);
  });
});

describe('getScannerContentImages', () => {
  it('short-circuits an empty batch WITHOUT running a query', async () => {
    const result = await getScannerContentImages(harness.db, []);
    expect(result).toEqual([]);
    expect(harness.queries).toHaveLength(0);
  });

  it('selects id+url for a batch of image ids', async () => {
    await getScannerContentImages(harness.db, [1, 2, 3]);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('select "id", "url" from "Image" where "id" in ($1, $2, $3)');
    expect(sql).not.toContain('in ()');
    expect(parameters).toEqual([1, 2, 3]);
  });
});
