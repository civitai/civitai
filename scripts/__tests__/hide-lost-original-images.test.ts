import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The real hold predicates have their own suites; here a held image is one listed in "ImageHeld",
// a held owner one listed in "OwnerHeld".
vi.mock('~/server/services/legal-hold.service', () => ({
  captureImageHeldSql: (alias: string) =>
    Prisma.sql`(${Prisma.raw(alias)}.id IN (SELECT "imageId" FROM "ImageHeld"))`,
  ownerHeldSql: (owner: Prisma.Sql) => Prisma.sql`(${owner} IN (SELECT "userId" FROM "OwnerHeld"))`,
}));

import {
  appendDurable,
  CROSS_CHECK_EXPIRES,
  isMissingHead,
  parseArgs,
  readIds,
  readLog,
  rebust,
  run,
  undo,
  type Deps,
  type RunOptions,
} from '../oneoffs/hide-lost-original-images';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending','Scanned','Error','Blocked','NotFound','PendingManualAssignment','Rescan');
    CREATE TABLE "ImageHeld" ("imageId" int);
    CREATE TABLE "OwnerHeld" ("userId" int);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, url text NOT NULL, "userId" int NOT NULL, "postId" int,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "needsReview" text, "blockedFor" text, "tosViolation" boolean NOT NULL DEFAULT false,
      minor boolean NOT NULL DEFAULT false, poi boolean NOT NULL DEFAULT false,
      "scanJobs" jsonb, "scanRequestedAt" timestamp, "scannedAt" timestamp
    );
    CREATE TABLE "CollectionItem" ("imageId" int, status text NOT NULL);
  `);
});

const GONE = [1, 2, 3];

beforeEach(async () => {
  await db.exec(`
    TRUNCATE "Image", "ImageHeld", "OwnerHeld", "CollectionItem";
    INSERT INTO "Image" (id, url, "userId", "postId") VALUES
      (1,'gone-1',10,100),(2,'gone-2',10,100),(3,'gone-3',11,101),
      (900,'live-900',12,102),(901,'live-901',12,102);
  `);
});

const query: Deps['query'] = async <T>(sql: Prisma.Sql) => {
  const r = await db.query(sql.text, sql.values as unknown[]);
  return r.rows as T[];
};
const ingestion = async (id: number) =>
  (
    (await db.query(`SELECT ingestion::text AS i FROM "Image" WHERE id=${id}`)).rows[0] as {
      i: string;
    }
  ).i;

const options = (over: Partial<RunOptions> = {}): RunOptions => ({
  apply: true,
  undo: false,
  idsFile: 'ids',
  logFile: 'log',
  limit: Number.MAX_SAFE_INTEGER,
  chunk: 200,
  concurrency: 4,
  pauseMs: 0,
  crossCheckRerun: false,
  rebust: null,
  ...over,
});

function makeDeps(over: Partial<Deps> = {}) {
  const logged: { id: number; prior: string }[] = [];
  const propagated: { ids: number[]; action: string }[] = [];
  const lines: string[] = [];
  const deps: Deps = {
    query,
    head: async (url) => {
      if (url.startsWith('gone-')) return 'missing';
      return 'present';
    },
    isExternal: (url) => url.startsWith('http'),
    propagate: async (touched, action) => {
      propagated.push({ ids: touched.map((t) => t.id), action });
    },
    appendLog: (e) => logged.push(...e),
    sleep: async () => undefined,
    log: (l) => lines.push(l),
    now: () => CROSS_CHECK_EXPIRES - 1000,
    ...over,
  };
  return { deps, logged, propagated, lines };
}

describe('hide-lost-original-images', () => {
  it('hides only ids that still 404, logs the prior value, and propagates them', async () => {
    const { deps, logged, propagated } = makeDeps({
      head: async (url) =>
        url === 'gone-2' ? 'present' : url.startsWith('gone-') ? 'missing' : 'present',
    });
    const counts = await run(options(), GONE, deps);
    expect([await ingestion(1), await ingestion(2), await ingestion(3)]).toEqual([
      'NotFound',
      'Scanned',
      'NotFound',
    ]);
    expect(logged).toEqual([
      { id: 1, prior: 'Scanned' },
      { id: 3, prior: 'Scanned' },
    ]);
    expect(propagated).toEqual([{ ids: [1, 3], action: 'hide' }]);
    expect(counts['skipped:now-200']).toBe(1);
    expect(counts.hidden).toBe(2);
  });

  it('skips an id whose HEAD errors rather than hiding it', async () => {
    const { deps } = makeDeps({
      head: async (url) => {
        if (url === 'gone-1') throw new Error('throttled');
        return url.startsWith('gone-') ? 'missing' : 'present';
      },
    });
    const counts = await run(options(), GONE, deps);
    expect(await ingestion(1)).toBe('Scanned');
    expect(counts['skipped:head-error']).toBe(1);
  });

  it('leaves held, in-review and non-Scanned rows alone and says why', async () => {
    await db.exec(`
      INSERT INTO "ImageHeld" VALUES (1);
      INSERT INTO "OwnerHeld" VALUES (11);
      UPDATE "Image" SET "needsReview" = 'minor' WHERE id = 2;
    `);
    const { deps } = makeDeps();
    const counts = await run(options(), GONE, deps);
    expect([await ingestion(1), await ingestion(2), await ingestion(3)]).toEqual([
      'Scanned',
      'Scanned',
      'Scanned',
    ]);
    expect(counts['skipped:image-hold']).toBe(1);
    expect(counts['skipped:needs-review']).toBe(1);
    expect(counts['skipped:owner-hold']).toBe(1);
  });

  it('a hold placed after the check still stops the write', async () => {
    const { deps } = makeDeps({
      head: async (url) => {
        if (url === 'gone-1') await db.exec(`INSERT INTO "ImageHeld" VALUES (1)`);
        return url.startsWith('gone-') ? 'missing' : 'present';
      },
    });
    const counts = await run(options(), GONE, deps);
    expect(await ingestion(1)).toBe('Scanned');
    expect(counts['raced-out']).toBe(1);
  });

  it('writes nothing on a dry run', async () => {
    const { deps, logged, propagated } = makeDeps();
    const counts = await run(options({ apply: false }), GONE, deps);
    expect(await ingestion(1)).toBe('Scanned');
    expect(logged).toEqual([]);
    expect(propagated).toEqual([]);
    expect(counts['would-hide']).toBe(3);
  });

  it('a second run changes nothing', async () => {
    const first = makeDeps();
    await run(options(), GONE, first.deps);
    const second = makeDeps();
    const counts = await run(options(), GONE, second.deps);
    expect(second.logged).toEqual([]);
    expect(counts.hidden).toBe(0);
    expect(counts['skipped:not-scanned']).toBe(3);
  });

  it('--limit 1 hides exactly one', async () => {
    const { deps } = makeDeps();
    const counts = await run(options({ limit: 1 }), GONE, deps);
    expect(counts.hidden).toBe(1);
    expect([await ingestion(1), await ingestion(2), await ingestion(3)]).toEqual([
      'NotFound',
      'Scanned',
      'Scanned',
    ]);
  });

  it('refuses to trust a 404 when the control images do not HEAD present', async () => {
    const { deps } = makeDeps({ head: async () => 'missing' });
    await expect(run(options(), GONE, deps)).rejects.toThrow(/control failed/);
    expect(await ingestion(1)).toBe('Scanned');
  });

  it('refuses a write after the cross-check expires unless it was re-run', async () => {
    const { deps } = makeDeps({ now: () => CROSS_CHECK_EXPIRES + 1 });
    await expect(run(options(), GONE, deps)).rejects.toThrow(/expired/);
    await expect(run(options({ crossCheckRerun: true }), GONE, deps)).resolves.toBeDefined();
  });

  it('undo restores the prior value only where the row is still NotFound', async () => {
    const { deps, propagated } = makeDeps();
    await run(options(), GONE, deps);
    await db.exec(`UPDATE "Image" SET ingestion = 'Blocked' WHERE id = 3`);
    const restored = await undo(
      GONE.map((id) => ({ id, prior: 'Scanned' })),
      options({ undo: true }),
      deps
    );
    expect(restored).toBe(2);
    expect([await ingestion(1), await ingestion(2), await ingestion(3)]).toEqual([
      'Scanned',
      'Scanned',
      'Blocked',
    ]);
    expect(propagated.at(-1)?.action).toBe('undo');
  });

  it('leaves an image alone while it is a pending item in a collection', async () => {
    await db.exec(`INSERT INTO "CollectionItem" VALUES (1, 'REVIEW'), (2, 'ACCEPTED')`);
    const { deps } = makeDeps();
    const counts = await run(options(), GONE, deps);
    expect([await ingestion(1), await ingestion(2)]).toEqual(['Scanned', 'NotFound']);
    expect(counts['skipped:pending-collection-item']).toBe(1);
  });

  it('skips an external url without a HEAD', async () => {
    await db.exec(`UPDATE "Image" SET url = 'http://elsewhere/x' WHERE id = 1`);
    const heads: string[] = [];
    const { deps } = makeDeps({
      head: async (u) => {
        heads.push(u);
        return u.startsWith('gone-') ? 'missing' : 'present';
      },
    });
    const counts = await run(options(), GONE, deps);
    expect(heads).not.toContain('http://elsewhere/x');
    expect(counts['skipped:external-url']).toBe(1);
  });

  it('--limit holds across chunks', async () => {
    const { deps } = makeDeps();
    const counts = await run(options({ limit: 2, chunk: 1 }), GONE, deps);
    expect(counts.hidden).toBe(2);
    expect(await ingestion(3)).toBe('Scanned');
  });

  it('reports scan-in-flight by both signals and their overlap, without writing', async () => {
    await db.exec(`
      UPDATE "Image" SET "scanJobs" = '{"workflowId":"w"}' WHERE id IN (1, 2);
      UPDATE "Image" SET "scannedAt" = '2024-01-01', "scanRequestedAt" = '2024-02-01' WHERE id = 3;
    `);
    const { deps } = makeDeps();
    const counts = await run(options({ apply: false }), GONE, deps);
    expect(counts['scan-in-flight:workflow-present']).toBe(2);
    expect(counts['scan-in-flight:requested-after-scanned']).toBe(1);
    expect(counts['scan-in-flight:both']).toBe(0);
  });

  it('undo leaves a row that was held while hidden', async () => {
    const { deps } = makeDeps();
    await run(options(), GONE, deps);
    await db.exec(`INSERT INTO "ImageHeld" VALUES (1)`);
    const restored = await undo(
      GONE.map((id) => ({ id, prior: 'Scanned' })),
      options({ undo: true }),
      deps
    );
    expect(restored).toBe(2);
    expect(await ingestion(1)).toBe('NotFound');
  });

  it('a failed cache update stops the run, and --rebust catches the rows up', async () => {
    let fail = true;
    const calls: number[][] = [];
    const { deps, lines } = makeDeps({
      propagate: async (t) => {
        if (fail) throw new Error('redis down');
        calls.push(t.map((x) => x.id));
      },
    });
    await expect(run(options(), GONE, deps)).rejects.toThrow('redis down');
    expect(lines.join('\n')).toMatch(/run --rebust hide/);
    expect(await ingestion(1)).toBe('NotFound');
    fail = false;
    const n = await rebust(
      GONE.map((id) => ({ id, prior: 'Scanned' })),
      'hide',
      options(),
      deps
    );
    expect(n).toBe(3);
    expect(calls.flat().sort()).toEqual([1, 2, 3]);
  });

  it('reads the log with a torn last line, and the ids file strictly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hide-test-'));
    const log = path.join(dir, 'log');
    appendDurable(log, '{"id":1,"prior":"Scanned"}\n{"id":2,"prior":"Sca');
    expect(readLog(log)).toEqual([{ id: 1, prior: 'Scanned' }]);
    fs.writeFileSync(log, '{"id":1\n{"id":2,"prior":"Scanned"}\n');
    expect(() => readLog(log)).toThrow();
    const ids = path.join(dir, 'ids');
    fs.writeFileSync(ids, '3\n1\n3\n');
    expect(readIds(ids)).toEqual([1, 3]);
    fs.writeFileSync(ids, '99999999999\n');
    expect(() => readIds(ids)).toThrow(/not an id/);
  });

  it('counts only a 404 as proof the key is gone', () => {
    expect(isMissingHead({ name: 'NotFound' })).toBe(true);
    expect(isMissingHead({ name: 'NoSuchKey' })).toBe(true);
    expect(isMissingHead({ $metadata: { httpStatusCode: 404 } })).toBe(true);
    expect(isMissingHead({ name: 'Forbidden', $metadata: { httpStatusCode: 403 } })).toBe(false);
    expect(isMissingHead(new Error('timeout'))).toBe(false);
  });

  it('aborts when a quantile of the targets has no live image to vouch for it', async () => {
    const { deps } = makeDeps();
    await expect(run(options(), [...GONE, 1000], deps)).rejects.toThrow(/control failed/);
    expect(await ingestion(1)).toBe('Scanned');
  });

  it('reports how many control images vouched for the HEADs', async () => {
    const { deps } = makeDeps();
    const counts = await run(options({ apply: false }), GONE, deps);
    expect(counts.controls).toBe(5);
  });

  it('--rebust hide skips a row that is no longer NotFound; --rebust undo covers restored rows', async () => {
    const calls: { ids: number[]; action: string }[] = [];
    const { deps } = makeDeps({
      propagate: async (t, action) => {
        calls.push({ ids: t.map((x) => x.id).sort(), action });
      },
    });
    await run(options(), GONE, deps);
    calls.length = 0;
    await db.exec(`UPDATE "Image" SET ingestion = 'Blocked' WHERE id = 3`);
    const entries = GONE.map((id) => ({ id, prior: 'Scanned' }));
    expect(await rebust(entries, 'hide', options(), deps)).toBe(2);
    expect(calls).toEqual([{ ids: [1, 2], action: 'hide' }]);

    calls.length = 0;
    await undo(entries, options({ undo: true }), deps);
    calls.length = 0;
    expect(await rebust(entries, 'undo', options(), deps)).toBe(2);
    expect(calls).toEqual([{ ids: [1, 2], action: 'undo' }]);
  });

  it('parseArgs requires a log and, outside undo, an ids file', () => {
    expect(() => parseArgs(['--ids', 'a'])).toThrow(/--log/);
    expect(() => parseArgs(['--log', 'l'])).toThrow(/--ids/);
    expect(parseArgs(['--log', 'l', '--undo']).undo).toBe(true);
  });
});
