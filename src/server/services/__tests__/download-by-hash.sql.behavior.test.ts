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
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type { HashGate, ProviderHashGate } from '~/server/services/download-by-hash.service';

// The candidate SQL, run as written against an in-process Postgres; the gate is a fake per file.
vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ kysely: null as unknown }));
vi.mock('~/server/db/kyselyDb.lazy', () => ({
  loadKyselyDb: async () => ({ kyselyRead: holder.kysely }),
}));

const { pickFileByHash, pickProviderFileByHash, parseContentHash } = await import(
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
  poi boolean NOT NULL DEFAULT false, "deletedAt" timestamp(3),
  availability text NOT NULL DEFAULT 'Public'
);
CREATE TABLE "ModelVersion" (
  id int PRIMARY KEY, "modelId" int NOT NULL, status text NOT NULL, "publishedAt" timestamp(3),
  "usageControl" text NOT NULL DEFAULT 'Download', "requireAuth" boolean NOT NULL DEFAULT false,
  availability text NOT NULL DEFAULT 'Public'
);
CREATE TABLE "ModelFile" (
  id int PRIMARY KEY, "modelVersionId" int NOT NULL, "sizeKB" double precision NOT NULL,
  visibility text NOT NULL DEFAULT 'Public', "pickleScanResult" text NOT NULL DEFAULT 'Success',
  "virusScanResult" text NOT NULL DEFAULT 'Success', type text NOT NULL DEFAULT 'Model'
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
  loggingMock.logToAxiom.mockClear();
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
  modelAvailability?: string;
  versionAvailability?: string;
  paidEndsDaysAgo?: number;
  /** Any other column, set after the row is written. */
  model?: Record<string, unknown>;
  version?: Record<string, unknown>;
  file?: Record<string, unknown>;
};

async function set(table: string, id: number, cols: Record<string, unknown> = {}) {
  for (const [col, value] of Object.entries(cols))
    await pg.query(`UPDATE "${table}" SET "${col}" = $1 WHERE id = $2`, [value, id]);
}

/** One file carrying HASH. Model, version and file all take the id `id`; lower ids are older. */
async function copy(id: number, c: Copy = {}) {
  await pg.query(
    `INSERT INTO "Model" (id, "userId", status, mode, availability) VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      c.ownerId ?? OWNER + 100,
      c.modelStatus ?? 'Published',
      c.mode ?? null,
      c.modelAvailability ?? 'Public',
    ]
  );
  await pg.query(
    `INSERT INTO "ModelVersion" (id, "modelId", status, "publishedAt", availability)
     VALUES ($1, $1, $2, now() - make_interval(days => $3), $4)`,
    [
      id,
      c.versionStatus ?? 'Published',
      c.publishedDaysAgo ?? 1000 - id,
      c.versionAvailability ?? 'Public',
    ]
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
  await set('Model', id, c.model);
  await set('ModelVersion', id, c.version);
  await set('ModelFile', id, c.file);
  if (c.paid || c.paidEndsDaysAgo !== undefined)
    await pg.query(
      `INSERT INTO "PaidAccess" ("entityType", "entityId", "endsAt")
       VALUES ('ModelVersion', $1, now() - make_interval(days => $2))`,
      [id, c.paidEndsDaysAgo ?? null]
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
const logs = () => loggingMock.logToAxiom.mock.calls.map(([data]) => data);
const messages = () => logs().map((l) => (l as { message: string }).message);

describe('choosing among files that share a hash', () => {
  it('tries a free copy before a paid one, even when the paid one is older', async () => {
    await copy(1, { paid: true, publishedDaysAgo: 30 });
    await copy(2, { publishedDaysAgo: 1 });
    const gate = fakeGate([1, 2]);

    const result = await pick(gate, { id: STRANGER });

    expect(result.fileResult).toMatchObject({ status: 'success', fileId: 2 });
    expect(tried(gate)).toEqual([2]);
  });

  it("tries the caller's own copy first, even an unpublished one", async () => {
    await copy(1, { publishedDaysAgo: 30 });
    await copy(2, { ownerId: OWNER, versionStatus: 'Draft', publishedDaysAgo: 1 });
    const gate = fakeGate([1, 2]);

    expect((await pick(gate, { id: OWNER })).fileResult).toMatchObject({ fileId: 2 });
    // Control: anyone else never reaches the draft.
    const other = fakeGate([1, 2]);
    expect((await pick(other, { id: STRANGER })).fileResult).toMatchObject({ fileId: 1 });
    expect(tried(other)).toEqual([1]);
  });

  it("tries the oldest copy first, so a re-upload never takes the original's downloads", async () => {
    await copy(1, { publishedDaysAgo: 2 });
    await copy(2, { publishedDaysAgo: 400 });
    const gate = fakeGate([1, 2]);

    expect((await pick(gate, { id: STRANGER })).fileResult).toMatchObject({ fileId: 2 });
    expect(tried(gate)).toEqual([2]);
  });

  it('counts an expired paid window as free', async () => {
    await copy(1, { paid: true });
    await copy(2, { paidEndsDaysAgo: 1 });
    const gate = fakeGate([]);

    await pick(gate, { id: STRANGER });

    expect(tried(gate)).toEqual([2, 1]);
  });

  it('tries a login-only copy after an open one for an anonymous caller only', async () => {
    await copy(1, { version: { requireAuth: true } });
    await copy(2);

    const anon = fakeGate([]);
    await pick(anon);
    expect(tried(anon)).toEqual([2, 1]);

    const signedIn = fakeGate([]);
    await pick(signedIn, { id: STRANGER });
    expect(tried(signedIn)).toEqual([1, 2]);
  });

  it('tries a published copy before an unpublished one a moderator can reach', async () => {
    await copy(1, { versionStatus: 'Draft' });
    await copy(2, { paid: true });
    const gate = fakeGate([]);

    await pick(gate, { id: STRANGER, isModerator: true });

    expect(tried(gate)).toEqual([2, 1]);
  });

  it('runs at most five copies through the gate', async () => {
    for (let id = 1; id <= 6; id++) await copy(id);
    // Copy 6 is the newest, so it is tried last.
    const gate = fakeGate([6]);

    const result = await pick(gate, { id: STRANGER });

    expect(result.fileResult.status).toBe('not-found');
    expect(tried(gate)).toEqual([1, 2, 3, 4, 5]);
    expect(messages()).toEqual(['capped_refusal']);

    // Control: the same passing copy within the first five is served.
    loggingMock.logToAxiom.mockClear();
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

  it('logs a refusal as capped only when copies were left untried', async () => {
    await copy(1);
    await copy(2, { modelStatus: 'Deleted' });

    expect((await pick(fakeGate([]))).fileResult.status).toBe('not-found');
    expect(messages()).not.toContain('capped_refusal');
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

  it('serves the next copy when one copy cannot be resolved from storage', async () => {
    await copy(1);
    await copy(2);
    const gate = fakeGate([2], { 1: 'resolve-failed' });

    expect((await pick(gate)).fileResult).toMatchObject({ fileId: 2 });
    // A storage failure is answered only when no copy gave a refusal or passed.
    expect((await pick(fakeGate([], { 1: 'resolve-failed' }))).fileResult.status).toBe(
      'resolve-failed'
    );
    expect(
      (await pick(fakeGate([], { 1: 'resolve-failed', 2: 'early-access' }))).fileResult.status
    ).toBe('early-access');
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

  it('never offers a stranger a private copy, so a refusal cannot reveal one', async () => {
    await copy(1, { modelAvailability: 'Private' });
    await copy(2, { versionAvailability: 'Private' });
    const gate = fakeGate([]);

    expect((await pick(gate, { id: STRANGER })).fileResult.status).toBe('not-found');
    expect(gate).not.toHaveBeenCalled();

    // Control: the owner and a moderator are still offered both.
    await pg.query(`UPDATE "Model" SET "userId" = $1`, [OWNER]);
    const owner = fakeGate([]);
    await pick(owner, { id: OWNER });
    expect(tried(owner)).toEqual([1, 2]);
    const mod = fakeGate([]);
    await pick(mod, { id: STRANGER, isModerator: true });
    expect(tried(mod)).toEqual([1, 2]);
  });

  it.each([
    ['a POI model', { model: { poi: true } }],
    ['a failed virus scan', { file: { virusScanResult: 'Danger' } }],
    ['generation-only use', { version: { usageControl: 'Generation' } }],
    ['an unpublished model', { modelStatus: 'Unpublished' }],
    ['an unpublished version', { versionStatus: 'Draft' }],
    ['a private file', { visibility: 'Private' }],
  ] as [string, Copy][])('never offers a stranger a copy on %s', async (_, excluded) => {
    await copy(1, excluded);
    await copy(2);
    const gate = fakeGate([]);

    await pick(gate, { id: STRANGER });

    expect(tried(gate)).toEqual([2]);
  });

  it("offers an owner their copy on a model that isn't published yet", async () => {
    await copy(1, { ownerId: OWNER, modelStatus: 'Draft', versionStatus: 'Draft' });
    const gate = fakeGate([]);

    await pick(gate, { id: OWNER });

    expect(tried(gate)).toEqual([1]);
  });

  it('taken-down models are not downloadable except by moderators', async () => {
    await copy(1, { ownerId: OWNER, mode: 'TakenDown' });
    await copy(2, { ownerId: OWNER });

    for (const viewer of [{ id: OWNER }, { id: STRANGER }, undefined]) {
      const gate = fakeGate([]);
      await pick(gate, viewer);
      expect(tried(gate)).toEqual([2]);
    }
    // Control: a moderator is still offered it.
    const mod = fakeGate([]);
    await pick(mod, { id: STRANGER, isModerator: true });
    expect(tried(mod)).toEqual([1, 2]);
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
    expect(messages()).toEqual(['hash_size_mismatch']);
  });

  it('serves copies within 1 KB of each other', async () => {
    await copy(1, { sizeKB: 100 });
    await copy(2, { sizeKB: 101 });
    const gate = fakeGate([1, 2]);

    expect((await pick(gate)).fileResult.status).toBe('success');
    expect(logs()).toEqual([]);
  });

  it('refuses copies just over 1 KB apart', async () => {
    await copy(1, { sizeKB: 100 });
    await copy(2, { sizeKB: 101.01 });

    expect((await pick(fakeGate([1, 2]))).fileResult.status).toBe('not-found');
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
    expect(messages()).toEqual(['served_with_taken_down_copy']);
  });

  it.each([
    ['a taken-down model', { mode: 'TakenDown' }],
    ['a model with a deletion date', { model: { deletedAt: new Date() } }],
    ['a deleted model', { modelStatus: 'Deleted' }],
    ['a model unpublished for a violation', { modelStatus: 'UnpublishedViolation' }],
  ] as [string, Copy][])('counts a copy on %s as taken down', async (_, takenDown) => {
    await copy(1);
    await copy(2, takenDown);

    await pick(fakeGate([1]));

    expect(messages()).toEqual(['served_with_taken_down_copy']);
  });

  it('logs nothing when no copy was taken down', async () => {
    await copy(1);
    await copy(2);

    expect((await pick(fakeGate([1]))).fileResult.status).toBe('success');
    expect(logs()).toEqual([]);
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

describe('a provider token holder', () => {
  /** A provider gate that passes the listed files and refuses each other one as listed. */
  function providerGate(pass: number[], refusals: Record<number, string> = {}) {
    return vi.fn<ProviderHashGate>(async ({ fileId, modelVersionId }) =>
      pass.includes(fileId)
        ? ({ ok: true, fileId, modelVersionId } as Awaited<ReturnType<ProviderHashGate>>)
        : ({ ok: false, error: refusals[fileId] ?? 'not-found' } as Awaited<
            ReturnType<ProviderHashGate>
          >)
    );
  }
  const providerPick = (gate: ProviderHashGate) =>
    pickProviderFileByHash({ hash: HASH, kind: 'sha256', provider: 'RunPods', gate });
  const providerTried = (gate: ReturnType<typeof providerGate>) =>
    gate.mock.calls.map(([a]) => a.fileId);

  it.each([
    ['a private model', { modelAvailability: 'Private' }],
    ['a private file', { visibility: 'Private' }],
    ['generation-only use', { version: { usageControl: 'Generation' } }],
    ['a draft version', { versionStatus: 'Draft' }],
    ['an unpublished model', { modelStatus: 'Unpublished' }],
  ] as [string, Copy][])('is offered a copy on %s that a stranger is not', async (_, c) => {
    await copy(1, c);

    const result = await providerPick(providerGate([1]));
    expect(result).toMatchObject({ ok: true, fileId: 1 });

    const stranger = fakeGate([1]);
    expect((await pick(stranger, { id: STRANGER })).fileResult.status).toBe('not-found');
    expect(stranger).not.toHaveBeenCalled();
  });

  it.each([
    ['a taken-down model', { mode: 'TakenDown' }],
    ['an archived model', { mode: 'Archived' }],
    ['a deleted model', { modelStatus: 'Deleted' }],
    ['a model with a deletion date', { model: { deletedAt: new Date() } }],
    ['a deleted version', { versionStatus: 'Deleted' }],
    ['a model unpublished for a violation', { modelStatus: 'UnpublishedViolation' }],
    ['a POI model', { model: { poi: true } }],
    ['a failed pickle scan', { scan: 'Danger' }],
    ['a failed virus scan', { file: { virusScanResult: 'Danger' } }],
    ['a training dataset', { file: { type: 'Training Data' } }],
  ] as [string, Copy][])('is never offered a copy on %s', async (_, excluded) => {
    await copy(1, excluded);
    await copy(2);
    const gate = providerGate([]);

    await providerPick(gate);
    expect(providerTried(gate)).toEqual([2]);
  });

  it('is refused as not-found without running the gate when only an excluded copy exists', async () => {
    await copy(1, { mode: 'TakenDown' });
    const gate = providerGate([1]);

    expect(await providerPick(gate)).toEqual({ ok: false, error: 'not-found' });
    expect(gate).not.toHaveBeenCalled();
  });

  it('serves the next copy the gate passes, and answers the most specific refusal', async () => {
    await copy(1);
    await copy(2);

    const gate = providerGate([2], { 1: 'in-review' });
    expect(await providerPick(gate)).toMatchObject({ ok: true, fileId: 2 });
    expect(providerTried(gate)).toEqual([1, 2]);

    expect(await providerPick(providerGate([], { 1: 'not-found', 2: 'in-review' }))).toEqual({
      ok: false,
      error: 'in-review',
    });
  });

  it.each([
    [{ 1: 'in-review', 2: 'not-found' }, 'in-review'],
    [{ 1: 'failed-scan', 2: 'no-generation' }, 'failed-scan'],
    [{ 1: 'no-generation', 2: 'failed-scan' }, 'failed-scan'],
    [{ 1: 'unsupported-file', 2: 'not-found' }, 'unsupported-file'],
  ] as const)(
    'answers the more specific refusal whichever copy holds it (%o)',
    async (refusals, error) => {
      await copy(1);
      await copy(2);

      expect(await providerPick(providerGate([], refusals))).toEqual({ ok: false, error });
    }
  );

  it('names the provider beside the URL kind in the hash logs', async () => {
    await copy(1, { mode: 'TakenDown' });
    await copy(2);

    await providerPick(providerGate([2]));

    expect(logs()).toContainEqual(
      expect.objectContaining({
        message: 'served_with_taken_down_copy',
        urlKind: 'sha256',
        provider: 'RunPods',
        servedFileId: 2,
      })
    );
  });
});
