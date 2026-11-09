import { PGlite } from '@electric-sql/pglite';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
} from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HashGate } from '~/server/services/download-by-hash.service';

// The candidate SQL, run as written against an in-process Postgres; the gate is a fake per file.
vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ kysely: null as unknown, logs: [] as unknown[] }));
vi.mock('~/server/db/kyselyDb.lazy', () => ({
  loadKyselyDb: async () => ({ kyselyRead: holder.kysely }),
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: async (data: unknown) => {
    holder.logs.push(data);
  },
}));

const { pickFileByHash, parseContentHash, MAX_HASH_CANDIDATES } = await import(
  '~/server/services/download-by-hash.service'
);

const dialect = (pg: PGlite): Dialect => {
  const connection: DatabaseConnection = {
    async executeQuery(compiled) {
      const result = await pg.query(compiled.sql, compiled.parameters as unknown[]);
      return { rows: result.rows as never[], numAffectedRows: BigInt(result.affectedRows ?? 0) };
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('not used');
    },
  };
  const noop = async () => undefined;
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => ({
      init: noop,
      acquireConnection: async () => connection,
      beginTransaction: noop,
      commitTransaction: noop,
      rollbackTransaction: noop,
      releaseConnection: noop,
      destroy: noop,
    }),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
};

const SCHEMA = `
CREATE TABLE "Model" (
  id int PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL, mode text,
  poi boolean NOT NULL DEFAULT false, "deletedAt" timestamp(3)
);
CREATE TABLE "ModelVersion" (
  id int PRIMARY KEY, "modelId" int NOT NULL, status text NOT NULL, "publishedAt" timestamp(3),
  "usageControl" text NOT NULL DEFAULT 'Download', "requireAuth" boolean NOT NULL DEFAULT false
);
CREATE TABLE "ModelFile" (
  id int PRIMARY KEY, "modelVersionId" int NOT NULL, "sizeKB" double precision NOT NULL,
  visibility text NOT NULL DEFAULT 'Public', "pickleScanResult" text NOT NULL DEFAULT 'Success',
  "virusScanResult" text NOT NULL DEFAULT 'Success'
);
CREATE TABLE "ModelFileHash" ("fileId" int NOT NULL, type text NOT NULL, hash text NOT NULL);
CREATE INDEX ON "ModelFileHash" (hash);
CREATE TABLE "PaidAccess" ("entityType" text NOT NULL, "entityId" int NOT NULL, "endsAt" timestamp(3));
`;

const HASH = 'AB'.repeat(32);
const OWNER = 7;
const STRANGER = 8;

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SCHEMA);
  holder.kysely = new Kysely({ dialect: dialect(pg) });
});
afterAll(() => pg.close());
beforeEach(async () => {
  holder.logs = [];
  await pg.exec(`TRUNCATE "Model", "ModelVersion", "ModelFile", "ModelFileHash", "PaidAccess"`);
});

type Copy = {
  ownerId?: number;
  modelStatus?: string;
  versionStatus?: string;
  mode?: string;
  publishedDaysAgo?: number;
  sizeKB?: number;
  visibility?: string;
  scan?: string;
  paid?: boolean;
  hashType?: string;
};

/** One file carrying HASH. Model, version and file all take the id `id`. */
async function copy(id: number, c: Copy = {}) {
  await pg.query(`INSERT INTO "Model" (id, "userId", status, mode) VALUES ($1, $2, $3, $4)`, [
    id,
    c.ownerId ?? OWNER + 100,
    c.modelStatus ?? 'Published',
    c.mode ?? null,
  ]);
  await pg.query(
    `INSERT INTO "ModelVersion" (id, "modelId", status, "publishedAt")
     VALUES ($1, $1, $2, now() - make_interval(days => $3))`,
    [id, c.versionStatus ?? 'Published', c.publishedDaysAgo ?? id]
  );
  await pg.query(
    `INSERT INTO "ModelFile" (id, "modelVersionId", "sizeKB", visibility, "pickleScanResult")
     VALUES ($1, $1, $2, $3, $4)`,
    [id, c.sizeKB ?? 1000, c.visibility ?? 'Public', c.scan ?? 'Success']
  );
  await pg.query(`INSERT INTO "ModelFileHash" ("fileId", type, hash) VALUES ($1, $2, $3)`, [
    id,
    c.hashType ?? 'SHA256',
    HASH,
  ]);
  if (c.paid)
    await pg.query(
      `INSERT INTO "PaidAccess" ("entityType", "entityId") VALUES ('ModelVersion', $1)`,
      [id]
    );
}

const success = (fileId: number) =>
  ({ status: 'success', fileId, modelVersionId: fileId } as Awaited<ReturnType<HashGate>>);

/** A gate that passes the listed files and gives each other file the listed refusal. */
function fakeGate(pass: number[], refusals: Record<number, string> = {}) {
  return vi.fn<HashGate>(async ({ fileId }) =>
    pass.includes(fileId)
      ? success(fileId)
      : ({ status: refusals[fileId] ?? 'not-found' } as Awaited<ReturnType<HashGate>>)
  );
}

const pick = (gate: HashGate, viewer?: { id?: number; isModerator?: boolean }, kind = 'sha256') =>
  pickFileByHash({ hash: HASH, kind: kind as 'sha256', viewer, gate });

const tried = (gate: ReturnType<typeof fakeGate>) => gate.mock.calls.map(([a]) => a.fileId);
const messages = () => holder.logs.map((l) => (l as { message: string }).message);

describe('choosing among files that share a hash', () => {
  it('tries a free copy before a paid one, even when the paid one is newer', async () => {
    await copy(1, { paid: true, publishedDaysAgo: 1 });
    await copy(2, { publishedDaysAgo: 30 });
    const gate = fakeGate([1, 2]);

    const result = await pick(gate, { id: STRANGER });

    expect(result.fileResult).toMatchObject({ status: 'success', fileId: 2 });
    expect(tried(gate)).toEqual([2]);
  });

  it("tries the caller's own copy first, even an unpublished one", async () => {
    await copy(1, { publishedDaysAgo: 1 });
    await copy(2, { ownerId: OWNER, versionStatus: 'Draft', publishedDaysAgo: 30 });
    const gate = fakeGate([1, 2]);

    expect((await pick(gate, { id: OWNER })).fileResult).toMatchObject({ fileId: 2 });
    // Control: anyone else never reaches the draft.
    const other = fakeGate([1, 2]);
    expect((await pick(other, { id: STRANGER })).fileResult).toMatchObject({ fileId: 1 });
    expect(tried(other)).toEqual([1]);
  });

  it('runs at most five copies through the gate', async () => {
    for (let id = 1; id <= 6; id++) await copy(id);
    // Copy 6 is the oldest, so it is tried last.
    const gate = fakeGate([6]);

    const result = await pick(gate, { id: STRANGER });

    expect(result.fileResult.status).toBe('not-found');
    expect(tried(gate)).toEqual([1, 2, 3, 4, 5]);
    expect(MAX_HASH_CANDIDATES).toBe(5);
    expect(messages()).toEqual(['capped_refusal']);

    // Control: the same passing copy within the first five is served.
    holder.logs = [];
    const within = fakeGate([5]);
    expect((await pick(within, { id: STRANGER })).fileResult).toMatchObject({ fileId: 5 });
    expect(messages()).toEqual([]);
  });

  it('answers with the most actionable refusal, naming its version', async () => {
    await copy(1);
    await copy(2);
    await copy(3);
    const gate = fakeGate([], { 1: 'not-found', 2: 'early-access', 3: 'unauthorized' });

    const result = await pick(gate);

    expect(result).toEqual({ fileResult: { status: 'early-access' }, modelVersionId: 2 });
    expect(tried(gate)).toEqual([1, 2, 3]);
  });

  it('ranks unauthorized over no-access over failed-scan over not-found', async () => {
    await copy(1);
    await copy(2);
    await copy(3);
    await copy(4);
    const refusals = { 1: 'not-found', 2: 'failed-scan', 3: 'no-access', 4: 'unauthorized' };
    expect((await pick(fakeGate([], refusals))).fileResult.status).toBe('unauthorized');
    expect((await pick(fakeGate([], { ...refusals, 4: 'not-found' }))).fileResult.status).toBe(
      'no-access'
    );
    expect(
      (await pick(fakeGate([], { ...refusals, 3: 'not-found', 4: 'not-found' }))).fileResult.status
    ).toBe('failed-scan');
  });

  it('stops at a storage failure instead of repeating it on every copy', async () => {
    await copy(1);
    await copy(2);
    const gate = fakeGate([2], { 1: 'resolve-failed' });

    expect((await pick(gate)).fileResult.status).toBe('resolve-failed');
    expect(tried(gate)).toEqual([1]);
  });
});

describe('the pre-filter only drops copies the gate would refuse this caller', () => {
  it('never offers a stranger a private, failed-scan, deleted or unpublished copy', async () => {
    await copy(1, { visibility: 'Private' });
    await copy(2, { scan: 'Danger' });
    await copy(3, { modelStatus: 'Deleted' });
    await copy(4, { versionStatus: 'Draft' });
    await copy(5, { mode: 'Archived' });
    await copy(9, { publishedDaysAgo: 100 });
    const gate = fakeGate([1, 2, 3, 4, 5, 9]);

    expect((await pick(gate, { id: STRANGER })).fileResult).toMatchObject({ fileId: 9 });
    expect(tried(gate)).toEqual([9]);
  });

  it('never offers an owner the copy on their own deleted model', async () => {
    await copy(1, { ownerId: OWNER, modelStatus: 'Deleted' });
    await copy(2, { ownerId: OWNER, versionStatus: 'Draft' });
    const gate = fakeGate([]);

    await pick(gate, { id: OWNER });

    expect(tried(gate)).toEqual([2]);
  });

  it('offers a moderator every copy but an archived one', async () => {
    await copy(1, { visibility: 'Private' });
    await copy(2, { scan: 'Danger' });
    await copy(3, { modelStatus: 'Deleted' });
    await copy(5, { mode: 'Archived' });
    const gate = fakeGate([]);

    await pick(gate, { id: STRANGER, isModerator: true });

    expect(tried(gate).sort()).toEqual([1, 2, 3]);
  });
});

describe('copies whose sizes disagree carry a wrong hash', () => {
  it('refuses as not-found without running the gate, and logs it', async () => {
    await copy(1, { sizeKB: 100 });
    await copy(2, { sizeKB: 1_600_000 });
    const gate = fakeGate([1, 2]);

    expect((await pick(gate)).fileResult.status).toBe('not-found');
    expect(gate).not.toHaveBeenCalled();
    expect(holder.logs).toEqual([
      expect.objectContaining({
        message: 'hash_size_mismatch',
        urlKind: 'sha256',
        groupSize: 2,
        sizeSpreadKB: 1_599_900,
      }),
    ]);
  });

  it('serves copies within 1 KB of each other', async () => {
    await copy(1, { sizeKB: 100 });
    await copy(2, { sizeKB: 100.5 });
    const gate = fakeGate([1, 2]);

    expect((await pick(gate)).fileResult.status).toBe('success');
    expect(holder.logs).toEqual([]);
  });

  it('ignores a size that only a copy the caller cannot get disagrees on', async () => {
    await copy(1, { sizeKB: 100 });
    await copy(2, { sizeKB: 5000, modelStatus: 'Deleted' });

    expect((await pick(fakeGate([1]))).fileResult).toMatchObject({ fileId: 1 });
  });
});

describe('taken-down copies are logged, not refused', () => {
  it('serves a live copy and logs the taken-down ones once', async () => {
    await copy(1);
    await copy(2, { modelStatus: 'UnpublishedViolation', sizeKB: 9000 });
    await copy(3, { modelStatus: 'Deleted' });

    const result = await pick(fakeGate([1]));

    expect(result.fileResult).toMatchObject({ status: 'success', fileId: 1 });
    expect(holder.logs).toHaveLength(1);
    expect(holder.logs[0]).toMatchObject({
      message: 'served_with_taken_down_copy',
      urlKind: 'sha256',
      servedFileId: 1,
      groupSize: 3,
      sizeMismatch: true,
    });
    expect([...(holder.logs[0] as { takenDownFileIds: number[] }).takenDownFileIds].sort()).toEqual(
      [2, 3]
    );
  });

  it('logs nothing when no copy was taken down', async () => {
    await copy(1);
    await copy(2);

    expect((await pick(fakeGate([1]))).fileResult.status).toBe('success');
    expect(holder.logs).toEqual([]);
  });
});

describe('the hash in the URL', () => {
  it('matches only its own hash type', async () => {
    await copy(1, { hashType: 'BLAKE3' });

    expect((await pick(fakeGate([1]), undefined, 'sha256')).fileResult.status).toBe('not-found');
    expect((await pick(fakeGate([1]), undefined, 'blake3')).fileResult.status).toBe('success');
  });

  it('accepts 64 hex characters in either case and nothing else', () => {
    expect(parseContentHash(HASH.toLowerCase())).toBe(HASH);
    expect(parseContentHash(HASH)).toBe(HASH);
    expect(parseContentHash(HASH.slice(1))).toBeNull();
    expect(parseContentHash(`${HASH.slice(1)}G`)).toBeNull();
    expect(parseContentHash([HASH])).toBeNull();
  });
});
