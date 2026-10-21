import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import archiver from 'archiver';
import { readFileSync } from 'fs';
import JSZip from 'jszip';
import path from 'path';
import { PassThrough } from 'stream';
import { fileURLToPath } from 'url';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkCsamArchiveEvidence,
  EVIDENCE_VERIFIED_AT,
  readZipEntryCount,
} from '~/server/services/csam-archive-evidence.service';
import { EVIDENCE_VERIFIED_KEY } from '~/server/services/cdn-access.service';
import { ensureRegisterCsamArchiveEvidenceMetrics } from '~/server/metrics/csam-archive.metrics';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * The evidence check marks a sent report's evidence copy verified only when every object its archive
 * recorded is still in storage unchanged, and every item the report names made it into the archive.
 * Runs the archive-object migration and the check's own SQL against a Postgres stand-in; storage is
 * an in-memory fake.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/civitai-db-schema/prisma/migrations/20261113120000_csam_report_archive_object/migration.sql'
);

const db = { pg: null as unknown as PGlite };
const BUCKET = 'evidence-bucket';
const NOW = new Date('2026-06-01T12:00:00.000Z');

type Stored = { etag: string; bytes: Buffer };

class FakeStorage {
  objects = new Map<string, Stored>();
  failing = new Set<string>();

  async send(command: { constructor: { name: string }; input: { Key: string; Range?: string } }) {
    if (this.failing.has(command.input.Key)) {
      throw Object.assign(new Error('internal error'), { name: 'InternalError' });
    }
    const object = this.objects.get(command.input.Key);
    if (!object) throw Object.assign(new Error('not found'), { name: 'NotFound' });
    if (command.constructor.name === 'HeadObjectCommand') return { ETag: `"${object.etag}"` };
    const range = command.input.Range ?? '';
    const suffix = range.match(/^bytes=-(\d+)$/);
    const span = range.match(/^bytes=(\d+)-(\d+)$/);
    const bytes = suffix
      ? object.bytes.subarray(Math.max(0, object.bytes.length - Number(suffix[1])))
      : span
      ? object.bytes.subarray(Number(span[1]), Number(span[2]) + 1)
      : object.bytes;
    return { Body: { transformToByteArray: async () => new Uint8Array(bytes) } };
  }
}

async function zipOf(entries: number) {
  const zip = new JSZip();
  for (let i = 0; i < entries; i++) zip.file(`entry-${i}.jpeg`, `bytes-${i}`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function zip64Of(entries: number, forceZip64 = true) {
  const archive = archiver('zip', { forceZip64 });
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise((resolve) => sink.on('end', resolve));
  archive.pipe(sink);
  for (let i = 0; i < entries; i++) archive.append(`bytes-${i}`, { name: `entry-${i}.jpeg` });
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

let storage: FakeStorage;
let nextReportId = 1;

async function addReport(
  type: string,
  { sentAt = NOW, archivedAt = NOW as Date | null, details = {} as object } = {}
) {
  const id = nextReportId++;
  await db.pg.query(
    `INSERT INTO "CsamReport" (id, type, "reportSentAt", "archivedAt", details) VALUES ($1, $2, $3, $4, $5)`,
    [id, type, sentAt, archivedAt, JSON.stringify(details)]
  );
  return id;
}

async function addObject(
  reportId: number,
  kind: string,
  {
    bytes = undefined as Buffer | undefined,
    stored = true,
    entries = null as number | null,
    namedExpected = null as number | null,
    namedMissing = null as number | null,
    recordEtag = true,
    quoteRecorded = true,
    storedEtag = undefined as string | undefined,
    uploadedAt = NOW,
    suffix = '',
  } = {}
) {
  const key = `synthetic/${reportId}/${kind}${suffix}`;
  // Multipart-shaped, and quoted on the recorded side as the upload returns it.
  const etag = `etag-${reportId}-${kind}${suffix}-3`;
  if (stored) {
    const content =
      bytes ?? (kind === 'base' ? Buffer.from(`${kind}-${reportId}`) : await zipOf(2));
    storage.objects.set(key, { etag: storedEtag ?? etag, bytes: content });
  }
  await db.pg.query(
    `INSERT INTO "CsamReportArchiveObject" ("csamReportId", kind, key, etag, entries, "namedExpected", "namedMissing", "uploadedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      reportId,
      kind,
      key,
      recordEtag ? (quoteRecorded ? `"${etag}"` : etag) : null,
      entries,
      namedExpected,
      namedMissing,
      uploadedAt,
    ]
  );
  return key;
}

async function addZip(
  reportId: number,
  kind: string,
  recorded: number,
  inStorage = recorded,
  options: Parameters<typeof addObject>[2] = {}
) {
  return addObject(reportId, kind, {
    bytes: await zipOf(inStorage),
    entries: recorded,
    namedExpected: 2,
    namedMissing: 0,
    ...options,
  });
}

const verifiedAt = async (id: number) =>
  (
    await db.pg.query<{ v: string | null }>(
      `SELECT details ->> 'evidenceVerifiedAt' AS v FROM "CsamReport" WHERE id = $1`,
      [id]
    )
  ).rows[0].v;

const run = () => checkCsamArchiveEvidence({ s3: storage, bucket: BUCKET, now: NOW });

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "CsamReport" (
      id int PRIMARY KEY,
      type text NOT NULL,
      "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}'
    );
  `);
  await db.pg.exec(readFileSync(MIGRATION, 'utf8'));
});

beforeEach(async () => {
  vi.clearAllMocks();
  loggingMock.logToAxiom.mockImplementation(() => ({ catch: () => undefined } as never));
  storage = new FakeStorage();
  // Each case starts from an empty archive-object table without deleting from it: its rows refuse
  // removal, so the table is recreated from the migration.
  await db.pg.exec(`
    DROP TABLE "CsamReportArchiveObject";
    DELETE FROM "CsamReport";
  `);
  await db.pg.exec(readFileSync(MIGRATION, 'utf8'));
  const raw = (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
    const sql = Array.isArray(first)
      ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
      : (first as Prisma.Sql);
    const result = await db.pg.query<Record<string, unknown>>(sql.text, sql.values);
    return result.rows;
  }) as never;
  const exec = (async (first: TemplateStringsArray, ...values: unknown[]) => {
    const sql = Prisma.sql(first, ...(values as never[]));
    return (await db.pg.query(sql.text, sql.values)).affectedRows ?? 0;
  }) as never;
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(raw);
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(exec);
});

describe('TrainingData report', () => {
  it('is verified when its base bundle and training zip are stored unchanged', async () => {
    const id = await addReport('TrainingData');
    await addObject(id, 'base');
    await addObject(id, 'trainingData');

    await run();

    expect(await verifiedAt(id)).toBe(NOW.toISOString());
  });

  it('is not verified when the training zip is not in storage', async () => {
    const id = await addReport('TrainingData');
    await addObject(id, 'base');
    await addObject(id, 'trainingData', { stored: false });

    const { counts } = await run();

    expect(await verifiedAt(id)).toBeNull();
    expect(counts.object_missing).toBe(1);
  });

  it('is not verified when the stored training data is not a complete zip', async () => {
    const id = await addReport('TrainingData');
    await addObject(id, 'base');
    await addObject(id, 'trainingData', { bytes: (await zipOf(2)).subarray(0, 40) });

    const { counts } = await run();

    expect(await verifiedAt(id)).toBeNull();
    expect(counts.entries_mismatch).toBe(1);
  });

  it('matches an ETag whether or not it was recorded with quotes', async () => {
    const id = await addReport('TrainingData');
    await addObject(id, 'base', { quoteRecorded: false });
    await addObject(id, 'trainingData');

    await run();

    expect(await verifiedAt(id)).toBe(NOW.toISOString());
  });

  it('does not count a report whose mark was not written', async () => {
    const id = await addReport('TrainingData');
    await addObject(id, 'base');
    await addObject(id, 'trainingData');
    vi.mocked(dbMock.dbWrite.$executeRaw).mockResolvedValueOnce(0 as never);

    const { verified, counts } = await run();

    expect(verified).toBe(0);
    expect(counts.check_error).toBe(1);
  });

  it('is not verified when the archive recorded no ETag to compare', async () => {
    const id = await addReport('TrainingData');
    await addObject(id, 'base');
    await addObject(id, 'trainingData', { recordEtag: false });

    const { counts } = await run();

    expect(await verifiedAt(id)).toBeNull();
    expect(counts.unverifiable).toBe(1);
  });

  it('is not verified when the base bundle is not in storage', async () => {
    const id = await addReport('TrainingData');
    await addObject(id, 'base', { stored: false });
    await addObject(id, 'trainingData');

    const { counts } = await run();

    expect(await verifiedAt(id)).toBeNull();
    expect(counts.object_missing).toBe(1);
  });

  it('is not verified when the base bundle was never recorded', async () => {
    const id = await addReport('TrainingData');
    await addObject(id, 'trainingData');

    await run();

    expect(await verifiedAt(id)).toBeNull();
  });
});

describe('Image report', () => {
  it('is verified when the zip holds every entry written and every named image', async () => {
    const id = await addReport('Image');
    await addObject(id, 'base');
    await addZip(id, 'images', 3);

    await run();

    expect(await verifiedAt(id)).toBe(NOW.toISOString());
  });

  it('is not verified when the report names no images', async () => {
    const id = await addReport('Image');
    await addObject(id, 'base');
    await addZip(id, 'images', 3, 3, { namedExpected: 0 });

    const { counts } = await run();

    expect(await verifiedAt(id)).toBeNull();
    expect(counts.unverifiable).toBe(1);
  });

  it.each([
    ['the latest copy passes', 'good', true],
    ['the latest copy fails', 'bad', false],
  ])('judges a report archived twice by its latest copy: %s', async (_case, latest, expected) => {
    const id = await addReport('Image');
    await addObject(id, 'base');
    const earlier = new Date(NOW.getTime() - 3600_000);
    await addZip(id, 'images', 3, 3, {
      suffix: '-a',
      uploadedAt: earlier,
      storedEtag: latest === 'good' ? 'changed' : undefined,
    });
    await addZip(id, 'images', 3, 3, {
      suffix: '-b',
      storedEtag: latest === 'bad' ? 'changed' : undefined,
    });

    await run();

    expect(await verifiedAt(id)).toBe(expected ? NOW.toISOString() : null);
  });

  it('is not verified when a named image could not be archived', async () => {
    const id = await addReport('Image');
    await addObject(id, 'base');
    await addObject(id, 'images', {
      bytes: await zipOf(1),
      entries: 1,
      namedExpected: 2,
      namedMissing: 1,
    });

    const { counts } = await run();

    expect(await verifiedAt(id)).toBeNull();
    expect(counts.images_missing).toBe(1);
  });

  it('is not verified when a stored object has changed since it was written', async () => {
    const id = await addReport('Image');
    await addObject(id, 'base');
    const key = await addZip(id, 'images', 3);
    storage.objects.set(key, { ...storage.objects.get(key)!, etag: 'replaced' });

    const { counts } = await run();

    expect(await verifiedAt(id)).toBeNull();
    expect(counts.object_missing).toBe(1);
  });
});

describe('GeneratedImage report', () => {
  it('is verified when the zip holds every entry written', async () => {
    const id = await addReport('GeneratedImage');
    await addObject(id, 'base');
    await addZip(id, 'generatedImages', 4);

    await run();

    expect(await verifiedAt(id)).toBe(NOW.toISOString());
  });

  it('is not verified when the stored zip holds fewer entries than were written', async () => {
    const id = await addReport('GeneratedImage');
    await addObject(id, 'base');
    await addZip(id, 'generatedImages', 4, 3);

    const { counts } = await run();

    expect(await verifiedAt(id)).toBeNull();
    expect(counts.entries_mismatch).toBe(1);
  });
});

describe('the check', () => {
  it('marks the other reports when one report cannot be checked', async () => {
    const failing = await addReport('TrainingData');
    await addObject(failing, 'base');
    storage.failing.add(await addObject(failing, 'trainingData'));
    const passing = await addReport('TrainingData');
    await addObject(passing, 'base');
    await addObject(passing, 'trainingData');

    const { counts } = await run();

    expect(await verifiedAt(failing)).toBeNull();
    expect(counts.check_error).toBe(1);
    expect(await verifiedAt(passing)).toBe(NOW.toISOString());
  });

  it('leaves an unsent report alone', async () => {
    const id = await addReport('TrainingData', { sentAt: null as never });
    await addObject(id, 'base');
    await addObject(id, 'trainingData');

    const { checked } = await run();

    expect(checked).toBe(0);
    expect(await verifiedAt(id)).toBeNull();
  });

  it('writes the mark the evidence-hold reader accepts', async () => {
    const id = await addReport('TrainingData');
    await addObject(id, 'base');
    await addObject(id, 'trainingData');

    await run();

    const { rows } = await db.pg.query<{ v: string | null }>(
      `SELECT details ->> $2 AS v FROM "CsamReport" WHERE id = $1`,
      [id, EVIDENCE_VERIFIED_KEY]
    );
    expect(EVIDENCE_VERIFIED_AT).toBe(EVIDENCE_VERIFIED_KEY);
    expect(rows[0].v).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/);
  });

  it('publishes the counts it found and when it ran', async () => {
    const id = await addReport('Image');
    await addObject(id, 'base');
    await addObject(id, 'images', { entries: 1, namedExpected: 2, namedMissing: 1 });

    await run();

    const { incomplete, lastRun } = ensureRegisterCsamArchiveEvidenceMetrics();
    const values = Object.fromEntries(
      (await incomplete.get()).values.map((v) => [v.labels.reason, v.value])
    );
    expect(values).toEqual({
      skipped: 0,
      stale: 0,
      images_missing: 1,
      object_missing: 0,
      entries_mismatch: 0,
      unverifiable: 0,
      check_error: 0,
    });
    expect((await lastRun.get()).values[0].value).toBe(NOW.getTime() / 1000);
  });

  it('never marks an external-link report', async () => {
    const id = await addReport('ExternalLink');
    await addObject(id, 'base');

    await run();

    expect(await verifiedAt(id)).toBeNull();
  });

  it('leaves a report archived before objects were recorded unmarked', async () => {
    const id = await addReport('TrainingData');

    const { checked } = await run();

    expect(checked).toBe(0);
    expect(await verifiedAt(id)).toBeNull();
  });

  it('keeps an existing mark as it is', async () => {
    const earlier = '2026-01-01T00:00:00.000Z';
    const id = await addReport('TrainingData', { details: { evidenceVerifiedAt: earlier } });
    await addObject(id, 'base');
    await addObject(id, 'trainingData');

    const { checked } = await run();

    expect(checked).toBe(0);
    expect(await verifiedAt(id)).toBe(earlier);
  });

  it('marks a report whose details hold nothing', async () => {
    const id = await addReport('TrainingData', { details: null as never });
    await db.pg.query(`UPDATE "CsamReport" SET details = 'null' WHERE id = $1`, [id]);
    await addObject(id, 'base');
    await addObject(id, 'trainingData');

    await run();

    expect(await verifiedAt(id)).toBe(NOW.toISOString());
  });

  it('counts reports whose archive was skipped or has not happened', async () => {
    await addReport('TrainingData', {
      archivedAt: null,
      details: { archiveSkipped: 'training data not found' },
    });
    const late = await addReport('Image', { archivedAt: null });
    const recent = await addReport('Image', { archivedAt: null });
    const fresh = await addReport('Image', { archivedAt: null });
    // Relative to the database clock, which is the one the check reads.
    await db.pg.query(
      `UPDATE "CsamReport" SET "reportSentAt" = now() - interval '12 hours' WHERE id = $1`,
      [late]
    );
    await db.pg.query(`UPDATE "CsamReport" SET "reportSentAt" = now() WHERE id = $1`, [recent]);
    await db.pg.query(
      `UPDATE "CsamReport" SET "reportSentAt" = now() - interval '5 hours' WHERE id = $1`,
      [fresh]
    );

    const { counts } = await run();

    expect(counts.skipped).toBe(1);
    expect(counts.stale).toBe(1);
  });

  it('never writes a storage key to the lines it logs', async () => {
    const ok = await addReport('TrainingData');
    const keys = [await addObject(ok, 'base'), await addObject(ok, 'trainingData')];
    const missing = await addReport('Image');
    keys.push(await addObject(missing, 'base', { stored: false }));
    keys.push(await addZip(missing, 'images', 2));

    await run();

    const logged = JSON.stringify(loggingMock.logToAxiom.mock.calls);
    expect(loggingMock.logToAxiom).toHaveBeenCalled();
    for (const key of keys) expect(logged).not.toContain(key);
  });
});

describe('archive object records', () => {
  it.each([
    ['changed', `UPDATE "CsamReportArchiveObject" SET etag = 'x'`],
    ['deleted', `DELETE FROM "CsamReportArchiveObject"`],
    ['truncated', `TRUNCATE "CsamReportArchiveObject"`],
  ])('cannot be %s', async (_case, statement) => {
    const id = await addReport('TrainingData');
    await addObject(id, 'base');
    await expect(db.pg.exec(statement)).rejects.toThrow();
  });
});

describe('readZipEntryCount', () => {
  it('reads the entry count of a zip64 archive', async () => {
    storage.objects.set('z64', { etag: 'e', bytes: await zip64Of(5) });
    expect(await readZipEntryCount(storage, BUCKET, 'z64')).toBe(5);
  });

  it('reads the entry count of an archive written by archiver, and of one with a comment', async () => {
    const zip = new JSZip();
    for (let i = 0; i < 3; i++) zip.file(`entry-${i}.jpeg`, `bytes-${i}`);
    storage.objects.set('commented', {
      etag: 'e',
      bytes: await zip.generateAsync({ type: 'nodebuffer', comment: 'x'.repeat(300) }),
    });
    storage.objects.set('plain', { etag: 'e', bytes: await zip64Of(4, false) });
    expect(await readZipEntryCount(storage, BUCKET, 'commented')).toBe(3);
    expect(await readZipEntryCount(storage, BUCKET, 'plain')).toBe(4);
  });

  it('returns null for an object that is not a zip', async () => {
    storage.objects.set('plain', { etag: 'e', bytes: Buffer.from('not a zip') });
    expect(await readZipEntryCount(storage, BUCKET, 'plain')).toBeNull();
  });
});
