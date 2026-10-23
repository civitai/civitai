import { PGlite } from '@electric-sql/pglite';
import type { Transaction } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  fileCheckState,
  reblockBountyEntryFileCheck,
} from '~/server/services/bounty-entry-file-check.service';
import { updateEntityFiles } from '~/server/services/file.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * An entrant saving a bounty entry's files, against an in-process Postgres so the jsonb writes are
 * the real ones, including when a moderator's re-block lands while the save is running.
 */

const SCHEMA = `
CREATE TABLE "File" (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, "sizeKB" DOUBLE PRECISION NOT NULL,
  "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL, metadata JSONB
);
CREATE SEQUENCE file_id START 100 OWNED BY "File".id;
ALTER TABLE "File" ALTER COLUMN id SET DEFAULT nextval('file_id');
CREATE TABLE "ModActivity" (
  id SERIAL PRIMARY KEY, "userId" INTEGER, activity TEXT NOT NULL,
  "entityType" TEXT, "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
`;

const INT4_ARRAY_OID = 1007;
const TEXT_ARRAY_OID = 1009;
const ENTRY = 55;
const OWN_FILE = 1;
const SECOND_FILE = 2;
const OTHER_ITEMS_FILE = 3;
const MOD = 7;
const URL = 'https://storage.example.com/default/8/lora.safetensors';
const NEW_URL = 'https://storage.example.com/default/8/other.safetensors';
const CHECKED = {
  sha256Server: 'F'.repeat(64),
  hashCheckedAt: '2026-10-20T00:00:00Z',
  hashAttemptedAt: '2026-10-20T00:00:00Z',
  blockedReason: 'other-users-model',
};
const CLEARED = {
  ...CHECKED,
  checkOverride: { by: 1, at: '2026-10-21T00:00:00Z', reason: 'their own alt account' },
};
const FORGED = {
  sha256Server: '0'.repeat(64),
  hashCheckedAt: 'x',
  hashAttemptedAt: 'x',
  hashFailCount: 0,
  hashLastError: '',
  blockedReason: '',
  checkOverride: { by: 2, at: 'x', reason: 'forged' },
};

let db: PGlite;
/** The open save transaction, so a re-block can be run inside it. */
let current: Transaction | null;
/** Runs once, just before the save's first write to a File row. */
let beforeFileWrite: (() => Promise<void>) | null;
/** The ids of the File rows the save updated, in the order it wrote them. */
let fileWrites: unknown[];

async function seed(
  id: number,
  entityId: number,
  metadata: object | null,
  url = URL,
  entityType = 'BountyEntry'
) {
  await db.query(
    `INSERT INTO "File" (id, name, url, "sizeKB", "entityType", "entityId", metadata)
     VALUES ($1, 'lora.safetensors', $2, 10, $5, $3, $4)`,
    [id, url, entityId, metadata === null ? null : JSON.stringify(metadata), entityType]
  );
}

async function files() {
  const { rows } = await db.query<{
    id: number;
    url: string;
    entityType: string;
    metadata: Record<string, unknown>;
  }>(`SELECT id, url, "entityType", metadata FROM "File" WHERE "entityId" = $1 ORDER BY id`, [
    ENTRY,
  ]);
  return rows;
}
const metadataOf = async (id: number) => (await files()).find((f) => f.id === id)?.metadata;

function rawRunner(t: Transaction) {
  return async (strings: TemplateStringsArray, values: unknown[]) => {
    const sql = Prisma.sql(strings, ...values);
    if (/^\s*UPDATE "File"/.test(sql.sql)) {
      await fireBeforeFileWrite();
      fileWrites.push(sql.values[sql.values.length - 3]);
    }
    // Prisma sends a JS array typed by its elements; PGlite would leave it untyped, and
    // trackModActivity's UNNEST cannot resolve an untyped parameter.
    const paramTypes = sql.values.map((v) =>
      !Array.isArray(v)
        ? 0
        : v.every((x) => typeof x === 'number')
        ? INT4_ARRAY_OID
        : TEXT_ARRAY_OID
    );
    return t.query(sql.text, sql.values, { paramTypes });
  };
}

async function fireBeforeFileWrite() {
  const hook = beforeFileWrite;
  beforeFileWrite = null;
  if (hook) await hook();
}

type FileData = { id?: number; name: string; url: string; sizeKB: number; metadata?: unknown };
type FileWhere = {
  id?: number | { in?: number[]; notIn?: number[] };
  entityId: number;
  entityType: string;
};

/** The Prisma calls the save makes on `tx.file`, as the SQL Prisma would send. */
function fileDelegate(t: Transaction) {
  const where = ({ id, entityId, entityType }: FileWhere, params: unknown[]) => {
    params.push(entityId, entityType);
    const clauses = [`"entityId" = $${params.length - 1}`, `"entityType" = $${params.length}`];
    if (typeof id === 'number') {
      params.push(id);
      clauses.push(`id = $${params.length}`);
    } else if (id?.in) {
      params.push(id.in);
      clauses.push(`id = ANY($${params.length}::int[])`);
    } else if (id?.notIn) {
      params.push(id.notIn);
      clauses.push(`NOT (id = ANY($${params.length}::int[]))`);
    }
    return clauses.join(' AND ');
  };
  return {
    findMany: async (args: { where: FileWhere }) => {
      const params: unknown[] = [];
      const { rows } = await t.query(
        `SELECT id, url, metadata FROM "File" WHERE ${where(args.where, params)}`,
        params
      );
      return rows;
    },
    updateMany: async (args: { where: FileWhere; data: FileData }) => {
      await fireBeforeFileWrite();
      const { name, url, sizeKB, metadata } = args.data;
      const params: unknown[] = [name, url, sizeKB, JSON.stringify(metadata)];
      const res = await t.query(
        `UPDATE "File" SET name = $1, url = $2, "sizeKB" = $3, metadata = $4::jsonb
         WHERE ${where(args.where, params)}`,
        params
      );
      return { count: res.affectedRows ?? 0 };
    },
    deleteMany: async (args: { where: FileWhere }) => {
      const params: unknown[] = [];
      const res = await t.query(`DELETE FROM "File" WHERE ${where(args.where, params)}`, params);
      return { count: res.affectedRows ?? 0 };
    },
    createMany: async (args: { data: (FileData & { entityId: number; entityType: string })[] }) => {
      for (const f of args.data)
        await t.query(
          `INSERT INTO "File" (name, url, "sizeKB", "entityType", "entityId", metadata)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [f.name, f.url, f.sizeKB, f.entityType, f.entityId, JSON.stringify(f.metadata)]
        );
      return { count: args.data.length };
    },
  };
}

function transactionClient(t: Transaction) {
  const run = rawRunner(t);
  return {
    file: fileDelegate(t),
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await run(strings, values)).affectedRows ?? 0,
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await run(strings, values)).rows,
  };
}

const file = (id?: number, extra: Partial<FileData> = {}) => ({
  ...(id && { id }),
  name: 'lora.safetensors',
  url: URL,
  sizeKB: 10,
  ...extra,
});

/** The entrant's save, in its own transaction, as upsertBountyEntry runs it. */
const save = (list: ReturnType<typeof file>[], entityId = ENTRY) =>
  db.transaction(async (t) => {
    current = t;
    try {
      await updateEntityFiles({
        tx: transactionClient(t) as never,
        entityId,
        entityType: 'BountyEntry',
        files: list as never,
        ownRights: true,
      });
    } finally {
      current = null;
    }
  });

const reblock = () =>
  reblockBountyEntryFileCheck({ fileId: OWN_FILE, userId: MOD, reason: 'the alt claim failed' });

loggingMock.logToAxiom.mockImplementation(() => Promise.resolve());

beforeEach(async () => {
  vi.clearAllMocks();
  db = new PGlite();
  await db.exec(SCHEMA);
  current = null;
  beforeFileWrite = null;
  fileWrites = [];

  // The moderator's re-block. PGlite has one connection, so a re-block landing during the save runs
  // inside the save's transaction: its write is what the save's next statement sees, as a re-block
  // that committed first is to that statement on Postgres.
  const conn = () => current ?? db;
  dbMock.dbWrite.file.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => {
    const { rows } = await conn().query(
      `SELECT id, url, "entityType", "entityId", metadata FROM "File" WHERE id = $1`,
      [where.id]
    );
    return rows[0] ?? null;
  }) as never);
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) => {
    if (current) return fn(transactionClient(current));
    return db.transaction((t) => fn(transactionClient(t)));
  }) as never);
});

afterEach(async () => {
  await db.close();
});

describe('a re-block landing while the entrant saves the same file', () => {
  it('leaves the file blocked, with the re-block recorded', async () => {
    await seed(OWN_FILE, ENTRY, { ...CLEARED, unlockAmount: 5 });
    beforeFileWrite = reblock;

    await save([file(OWN_FILE, { metadata: { unlockAmount: 6 } })]);

    expect(beforeFileWrite, 'the re-block ran during the save').toBeNull();
    const metadata = await metadataOf(OWN_FILE);
    expect(fileCheckState(metadata)).toBe('blocked');
    expect(metadata).toEqual({ ...CHECKED, unlockAmount: 6, ownRights: true });
    const { rows } = await db.query<{ activity: string }>(`SELECT activity FROM "ModActivity"`);
    expect(rows.map((r) => r.activity)).toEqual([
      `reblockFileCheck:${JSON.stringify({ fileId: OWN_FILE, reason: 'the alt claim failed' })}`,
    ]);
  });

  it('a url change landing first means the save is checked afresh', async () => {
    await seed(OWN_FILE, ENTRY, { ...CLEARED, unlockAmount: 5 });
    beforeFileWrite = async () => {
      await current!.query(`UPDATE "File" SET url = $1 WHERE id = $2`, [NEW_URL, OWN_FILE]);
    };

    await save([file(OWN_FILE, { metadata: { unlockAmount: 5 } })]);

    expect(beforeFileWrite, 'the url change ran during the save').toBeNull();
    expect(await metadataOf(OWN_FILE)).toEqual({ unlockAmount: 5, ownRights: true });
    expect(fileCheckState(await metadataOf(OWN_FILE))).toBe('unchecked');
  });
});

describe('updateEntityFiles', () => {
  it('keeps the check result of a file saved again at the same url, and updates the rest', async () => {
    await seed(OWN_FILE, ENTRY, { ...CLEARED, unlockAmount: 5 });

    await save([file(OWN_FILE, { name: 'renamed.safetensors', metadata: { unlockAmount: 7 } })]);

    expect(await metadataOf(OWN_FILE)).toEqual({ ...CLEARED, unlockAmount: 7, ownRights: true });
    const { rows } = await db.query<{ name: string }>(`SELECT name FROM "File" WHERE id = $1`, [
      OWN_FILE,
    ]);
    expect(rows[0].name).toBe('renamed.safetensors');
  });

  it('keeps the check result whatever the caller sends for it', async () => {
    await seed(OWN_FILE, ENTRY, { ...CLEARED, unlockAmount: 5 });

    await save([file(OWN_FILE, { metadata: { ...FORGED, unlockAmount: 7 } })]);

    expect(await metadataOf(OWN_FILE)).toEqual({ ...CLEARED, unlockAmount: 7, ownRights: true });
  });

  it("drops the check result when the file gets a new url, a moderator's clear with it", async () => {
    await seed(OWN_FILE, ENTRY, { ...CLEARED, unlockAmount: 5 });

    // The form sends back the metadata it read, so the old result rides along unless it is stripped.
    await save([file(OWN_FILE, { url: NEW_URL, metadata: { ...CLEARED, unlockAmount: 5 } })]);

    expect(await metadataOf(OWN_FILE)).toEqual({ unlockAmount: 5, ownRights: true });
    expect(fileCheckState(await metadataOf(OWN_FILE))).toBe('unchecked');
  });

  it('takes no check result from the caller on a new url either', async () => {
    await seed(OWN_FILE, ENTRY, { ...CLEARED, unlockAmount: 5 });

    await save([file(OWN_FILE, { url: NEW_URL, metadata: { ...FORGED, unlockAmount: 7 } })]);

    expect(await metadataOf(OWN_FILE)).toEqual({ unlockAmount: 7, ownRights: true });
  });

  it('checks a file afresh when its stored url changed before the save, even if the save sends the old url', async () => {
    await seed(OWN_FILE, ENTRY, { ...CLEARED, unlockAmount: 5 }, NEW_URL);

    await save([file(OWN_FILE, { metadata: { unlockAmount: 5 } })]);

    expect(await metadataOf(OWN_FILE)).toEqual({ unlockAmount: 5, ownRights: true });
  });

  // jsonb_each throws on a JSON array or scalar; SQL NULL alone would pass without the guard.
  it.each([
    ['missing', null],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
  ])('saves a file whose stored metadata is %s', async (_, stored) => {
    await seed(OWN_FILE, ENTRY, null);
    await db.query(`UPDATE "File" SET metadata = $1::jsonb WHERE id = $2`, [stored, OWN_FILE]);

    await save([file(OWN_FILE, { metadata: { unlockAmount: 1 } })]);

    expect(await metadataOf(OWN_FILE)).toEqual({ unlockAmount: 1, ownRights: true });
  });

  it('takes ownRights from the server, not from the caller', async () => {
    await seed(OWN_FILE, ENTRY, CLEARED);

    await save([
      file(OWN_FILE, { metadata: { ownRights: false } }),
      file(undefined, { metadata: { ownRights: false } }),
    ]);

    expect((await files()).map((f) => f.metadata.ownRights)).toEqual([true, true]);
  });

  it('updates several files of the item, each keeping its own check result', async () => {
    await seed(OWN_FILE, ENTRY, CLEARED);
    await seed(SECOND_FILE, ENTRY, CHECKED, NEW_URL);

    await save([file(SECOND_FILE, { url: NEW_URL }), file(OWN_FILE)]);

    expect(await metadataOf(OWN_FILE)).toEqual({ ...CLEARED, ownRights: true });
    expect(await metadataOf(SECOND_FILE)).toEqual({ ...CHECKED, ownRights: true });
  });

  // Two saves of one item that each lock its rows in their own order can deadlock each other.
  it('writes the files of a save in id order, whatever order they were sent in', async () => {
    await seed(OWN_FILE, ENTRY, CLEARED);
    await seed(SECOND_FILE, ENTRY, CHECKED);

    await save([file(SECOND_FILE), file(OWN_FILE)]);

    expect(fileWrites).toEqual([OWN_FILE, SECOND_FILE]);
  });

  it.each([
    ['another entry', 99, 'BountyEntry'],
    ['a bounty with the same id', ENTRY, 'Bounty'],
  ])('refuses a file id that belongs to %s, and changes nothing', async (_, entityId, type) => {
    await seed(OWN_FILE, ENTRY, CLEARED);
    await seed(OTHER_ITEMS_FILE, entityId, CHECKED, URL, type);
    const before = await db.query(`SELECT * FROM "File" ORDER BY id`);

    // The item's own file comes first, so it is written before the refusal and must be rolled back.
    await expect(
      save([file(OTHER_ITEMS_FILE), file(OWN_FILE, { name: 'renamed.safetensors' }), file()])
    ).rejects.toThrowError('A file to update is not part of this item.');

    expect((await db.query(`SELECT * FROM "File" ORDER BY id`)).rows).toEqual(before.rows);
  });

  it('adds a file sent without an id, never taking a check result from the caller', async () => {
    await save([file(undefined, { metadata: { ...FORGED, unlockAmount: 5 } })]);

    const [added] = await files();
    expect(added.entityType).toBe('BountyEntry');
    expect(added.metadata).toEqual({ unlockAmount: 5, ownRights: true });
  });

  it("removes a file of the item left out of the save, and no other item's", async () => {
    await seed(OWN_FILE, ENTRY, CLEARED);
    await seed(SECOND_FILE, ENTRY, CHECKED);
    await seed(OTHER_ITEMS_FILE, ENTRY, CHECKED, URL, 'Bounty');

    await save([file(OWN_FILE)]);

    expect((await files()).map((f) => f.id)).toEqual([OWN_FILE, OTHER_ITEMS_FILE]);
  });
});
