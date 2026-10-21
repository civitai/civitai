import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
  clearBountyEntryFileCheck,
  fileCheckState,
  reblockBountyEntryFileCheck,
} from '~/server/services/bounty-entry-file-check.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * A moderator's clear of a blocked bounty entry file, and the re-block that undoes it, run against
 * an in-process Postgres so the jsonb writes are the real ones.
 */

const SCHEMA = `
CREATE TABLE "Bounty" (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL,
  complete BOOLEAN NOT NULL DEFAULT false, refunded BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "BountyEntry" (id INTEGER PRIMARY KEY, "bountyId" INTEGER NOT NULL, "userId" INTEGER);
CREATE TABLE "BountyBenefactor" (
  "userId" INTEGER NOT NULL, "bountyId" INTEGER NOT NULL, "unitAmount" INTEGER NOT NULL,
  "awardedAt" TIMESTAMP(3), "awardedToId" INTEGER, "buzzTransactionId" TEXT[] NOT NULL DEFAULT '{}',
  PRIMARY KEY ("bountyId", "userId")
);
CREATE TABLE "File" (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, "sizeKB" DOUBLE PRECISION NOT NULL,
  "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL, metadata JSONB
);
CREATE TABLE "ModActivity" (
  id SERIAL PRIMARY KEY, "userId" INTEGER, activity TEXT NOT NULL,
  "entityType" TEXT, "entityId" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
`;

const INT4_ARRAY_OID = 1007;
const FILE_ID = 31;
const ENTRY_ID = 20;
const BOUNTY_ID = 10;
const URL = 'https://storage.example.com/u/31';
const MOD_A = 7;
const MOD_B = 8;
const BLOCKED = {
  ownRights: true,
  format: 'SafeTensor',
  hashCheckedAt: '2026-10-20T00:00:00Z',
  hashAttemptedAt: '2026-10-20T00:00:00Z',
  sha256Server: 'F'.repeat(64),
  blockedReason: 'other-users-model',
};

let db: PGlite;
/** Every statement the services sent through a transaction, in order. */
let statements: string[];

async function seed(metadata: object | null) {
  await db.query(
    `INSERT INTO "File" (id, name, url, "sizeKB", "entityType", "entityId", metadata)
     VALUES ($1, 'entry.safetensors', $2, 1024, 'BountyEntry', $3, $4)`,
    [FILE_ID, URL, ENTRY_ID, metadata === null ? null : JSON.stringify(metadata)]
  );
}

/** The whole File row as Postgres renders it: jsonb text is canonical, so equal text is equal rows. */
async function fileRow() {
  const { rows } = await db.query<{ row: string }>(
    `SELECT row_to_json(f)::text AS row FROM "File" f WHERE id = $1`,
    [FILE_ID]
  );
  return rows[0]?.row;
}

async function metadata() {
  const { rows } = await db.query<{ metadata: unknown }>(
    `SELECT metadata FROM "File" WHERE id = $1`,
    [FILE_ID]
  );
  return rows[0]?.metadata;
}

async function activities() {
  const { rows } = await db.query<{ userId: number; activity: string; entityId: number }>(
    `SELECT "userId", activity, "entityType", "entityId" FROM "ModActivity" ORDER BY id`
  );
  return rows;
}

const clear = (userId: number, reason: string) =>
  clearBountyEntryFileCheck({ fileId: FILE_ID, userId, reason });
const reblock = (userId: number, reason: string) =>
  reblockBountyEntryFileCheck({ fileId: FILE_ID, userId, reason });

loggingMock.logToAxiom.mockImplementation(() => Promise.resolve());

beforeEach(async () => {
  vi.clearAllMocks();
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(`
    INSERT INTO "Bounty" (id, type, complete) VALUES (${BOUNTY_ID}, 'LoraCreation', true);
    INSERT INTO "BountyEntry" (id, "bountyId", "userId") VALUES (${ENTRY_ID}, ${BOUNTY_ID}, 2);
    INSERT INTO "BountyBenefactor" ("userId", "bountyId", "unitAmount", "awardedAt", "awardedToId", "buzzTransactionId")
      VALUES (3, ${BOUNTY_ID}, 500, '2026-10-21T00:00:00Z', ${ENTRY_ID}, '{tx-1}');
  `);
  statements = [];

  dbMock.dbWrite.file.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => {
    const { rows } = await db.query(
      `SELECT id, url, "entityType", "entityId", metadata FROM "File" WHERE id = $1`,
      [where.id]
    );
    return rows[0] ?? null;
  }) as never);
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) =>
    db.transaction(async (t) => {
      const run = (strings: TemplateStringsArray, values: unknown[]) => {
        const sql = Prisma.sql(strings, ...values);
        statements.push(sql.sql.replace(/\s+/g, ' ').trim());
        // Prisma sends a JS number array as int[]; PGlite would leave it untyped, and
        // trackModActivity's UNNEST cannot resolve an untyped parameter.
        const paramTypes = sql.values.map((v) => (Array.isArray(v) ? INT4_ARRAY_OID : 0));
        return t.query(sql.text, sql.values, { paramTypes });
      };
      return fn({
        $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
          (await run(strings, values)).affectedRows ?? 0,
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
          (await run(strings, values)).rows,
      });
    })) as never);
});

afterEach(async () => {
  await db.close();
});

describe('clear then re-block', () => {
  it('returns the File row to exactly what it was before the clear', async () => {
    await seed(BLOCKED);
    const before = await fileRow();

    await clear(MOD_A, 'their own alt account');
    expect(fileCheckState(await metadata())).toBe('clean');

    await reblock(MOD_A, 'the alt claim did not hold up');
    expect(await fileRow()).toBe(before);
    expect(fileCheckState(await metadata())).toBe('blocked');
  });

  it('restores a malformed stored clear the clear replaced, value for value', async () => {
    // Metadata from before the check keys were server-only can hold anything; a clear writes over it.
    const planted = { by: '7', at: 'x', reason: 'planted', extra: [1, { a: null }] };
    await seed({ ...BLOCKED, checkOverride: planted });
    const before = await fileRow();

    await clear(MOD_A, 'their own alt account');
    expect(fileCheckState(await metadata())).toBe('clean');

    await reblock(MOD_A, 'the alt claim did not hold up');
    expect(await fileRow()).toBe(before);
  });

  it('restores a stored clear that was JSON null', async () => {
    await seed({ ...BLOCKED, checkOverride: null });
    const before = await fileRow();

    await clear(MOD_A, 'their own alt account');
    await reblock(MOD_A, 'the alt claim did not hold up');
    expect(await fileRow()).toBe(before);
  });

  it('records the clear and the re-block as ModActivity rows, each with its reason', async () => {
    await seed(BLOCKED);
    await clear(MOD_A, 'their own alt account');
    await reblock(MOD_B, 'the alt claim did not hold up');

    expect(await activities()).toEqual([
      {
        userId: MOD_A,
        entityType: 'bountyEntry',
        entityId: ENTRY_ID,
        activity: `clearFileCheck:${JSON.stringify({
          fileId: FILE_ID,
          reason: 'their own alt account',
        })}`,
      },
      {
        userId: MOD_B,
        entityType: 'bountyEntry',
        entityId: ENTRY_ID,
        activity: `reblockFileCheck:${JSON.stringify({
          fileId: FILE_ID,
          reason: 'the alt claim did not hold up',
        })}`,
      },
    ]);
  });

  it('can clear the file again after a re-block, and undo that too', async () => {
    await seed(BLOCKED);
    const before = await fileRow();
    await clear(MOD_A, 'first look');
    await reblock(MOD_A, 'second look');
    await clear(MOD_B, 'third look');
    expect(fileCheckState(await metadata())).toBe('clean');
    await reblock(MOD_B, 'fourth look');
    expect(await fileRow()).toBe(before);
  });

  // The moderator page lists such a file under Blocked again, with a Clear form.
  it.each([
    ['complete', 'complete = true, refunded = false'],
    ['refunded', 'complete = false, refunded = true'],
  ])('can clear a file re-blocked on a %s bounty', async (_, settled) => {
    await db.exec(`UPDATE "Bounty" SET ${settled}`);
    await seed(BLOCKED);
    await clear(MOD_A, 'first look');
    await reblock(MOD_A, 'second look');
    expect(fileCheckState(await metadata())).toBe('blocked');

    await clear(MOD_B, 'third look');
    expect(fileCheckState(await metadata())).toBe('clean');
  });
});

describe('re-block of a planted clear', () => {
  // A clear only writes over a value that is not a valid clear, so a valid `replaced` was planted:
  // restoring it would leave the file cleared while recording a re-block.
  it('removes the clear when the value it replaced is itself a valid clear', async () => {
    const inner = { by: 1, at: '2026-10-19T00:00:00Z', reason: 'planted inner' };
    await seed({
      ...BLOCKED,
      checkOverride: { by: 2, at: '2026-10-20T00:00:00Z', reason: 'planted', replaced: inner },
    });

    await reblock(MOD_A, 'undo the planted clear');

    expect(await metadata()).toEqual(BLOCKED);
    expect(fileCheckState(await metadata())).toBe('blocked');
    expect((await activities()).map((a) => a.activity.split(':')[0])).toEqual(['reblockFileCheck']);
  });

  it('refuses, and writes nothing, when the write would leave the file unblocked', async () => {
    await seed(BLOCKED);
    await clear(MOD_A, 'their own alt account');
    const read = dbMock.dbWrite.file.findUnique.getMockImplementation()!;
    let raced: string | undefined;
    dbMock.dbWrite.file.findUnique.mockImplementationOnce((async (args: never) => {
      const seen = await read(args);
      // Still present to the write's guard, but no longer a block.
      await db.query(
        `UPDATE "File" SET metadata = jsonb_set(metadata, '{blockedReason}', 'false'::jsonb)`
      );
      raced = await fileRow();
      return seen;
    }) as never);

    await expect(reblock(MOD_A, 'stale page')).rejects.toThrow("This file couldn't be re-blocked.");
    expect(raced).toContain('"checkOverride"');
    expect(await fileRow()).toBe(raced);
    expect((await activities()).map((a) => a.activity.split(':')[0])).toEqual(['clearFileCheck']);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', fileId: FILE_ID })
    );
  });

  // SQL reads the stored text `5.0` as no clear, JavaScript reads the parsed 5 as one: the write puts
  // it back, and the check after it refuses.
  it('refuses a replaced value the SQL and JavaScript rules judge differently, and writes nothing', async () => {
    const outer = { by: 2, at: '2026-10-20T00:00:00Z', reason: 'planted' };
    await db.query(
      `INSERT INTO "File" (id, name, url, "sizeKB", "entityType", "entityId", metadata)
       VALUES ($1, 'entry.safetensors', $2, 1024, 'BountyEntry', $3,
         $4::jsonb || jsonb_build_object('checkOverride', $5::jsonb || jsonb_build_object(
           'replaced', '{"by": 5.0, "at": "x", "reason": "planted inner"}'::jsonb)))`,
      [FILE_ID, URL, ENTRY_ID, JSON.stringify(BLOCKED), JSON.stringify(outer)]
    );
    expect(await fileRow()).toContain('"by": 5.0');
    const before = await fileRow();

    await expect(reblock(MOD_A, 'undo the planted clear')).rejects.toThrow(
      "This file couldn't be re-blocked."
    );
    expect(await fileRow()).toBe(before);
    expect(await activities()).toEqual([]);
  });
});

describe('re-block on an awarded bounty', () => {
  // Allowed on purpose: the moderator page shows the bounty is awarded next to the button. The
  // re-block withholds the file; it must never reach for the award or its payout.
  it('writes only the File row and its ModActivity row', async () => {
    await seed(BLOCKED);
    await clear(MOD_A, 'their own alt account');
    const bounty = await db.query(`SELECT row_to_json(b)::text FROM "Bounty" b`);
    const benefactors = await db.query(`SELECT row_to_json(b)::text FROM "BountyBenefactor" b`);
    statements = [];

    await reblock(MOD_A, 'the alt claim did not hold up');

    expect(statements.map((s) => s.match(/^(UPDATE|INSERT INTO) "(\w+)"/)?.slice(1, 3))).toEqual([
      ['UPDATE', 'File'],
      ['INSERT INTO', 'ModActivity'],
    ]);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    for (const model of ['bounty', 'bountyEntry', 'bountyBenefactor', 'buzzWithdrawalRequest'])
      for (const method of ['update', 'updateMany', 'create', 'delete', 'upsert'])
        expect(dbMock.dbWrite[model][method], `${model}.${method}`).not.toHaveBeenCalled();
    expect((await db.query(`SELECT row_to_json(b)::text FROM "Bounty" b`)).rows).toEqual(
      bounty.rows
    );
    expect((await db.query(`SELECT row_to_json(b)::text FROM "BountyBenefactor" b`)).rows).toEqual(
      benefactors.rows
    );
  });
});

describe('re-block refusals', () => {
  it.each([
    ['still blocked, never cleared', BLOCKED],
    ['carrying a malformed clear (it is blocked)', { ...BLOCKED, checkOverride: { by: '7' } }],
    ['clean', { hashCheckedAt: '2026-10-20T00:00:00Z' }],
    ['not checked yet', {}],
  ])('refuses a file %s, and writes nothing', async (_, meta) => {
    await seed(meta);
    const before = await fileRow();
    await expect(reblock(MOD_A, 'why')).rejects.toThrow('This file has no clear to undo.');
    expect(await fileRow()).toBe(before);
    expect(await activities()).toEqual([]);
  });

  it('refuses a file that is not a bounty entry file', async () => {
    await seed({ ...BLOCKED, checkOverride: { by: 1, at: 'x', reason: 'r' } });
    await db.query(`UPDATE "File" SET "entityType" = 'Article'`);
    await expect(reblock(MOD_A, 'why')).rejects.toThrow(`No bounty entry file ${FILE_ID}.`);
    expect(await activities()).toEqual([]);
  });

  // The moderator undoes the clear they were shown. If another moderator re-blocked and cleared it
  // again in between, that newer clear is not theirs to undo from a stale page.
  it('refuses when the clear changed between the read and the write, and leaves the newer clear', async () => {
    await seed(BLOCKED);
    await clear(MOD_A, 'first clear');
    const read = dbMock.dbWrite.file.findUnique.getMockImplementation()!;
    dbMock.dbWrite.file.findUnique.mockImplementationOnce((async (args: never) => {
      const seen = await read(args);
      // Another moderator acts after this read, before this write.
      dbMock.dbWrite.file.findUnique.mockImplementation(read);
      await reblock(MOD_B, 'second look');
      await clear(MOD_B, 'second clear');
      return seen;
    }) as never);

    await expect(reblock(MOD_A, 'stale page')).rejects.toThrow(
      'This file changed while you were reviewing it. Reload and try again.'
    );
    const meta = (await metadata()) as { checkOverride: { by: number; reason: string } };
    expect(meta.checkOverride).toMatchObject({ by: MOD_B, reason: 'second clear' });
    expect((await activities()).map((a) => a.activity.split(':')[0])).toEqual([
      'clearFileCheck',
      'reblockFileCheck',
      'clearFileCheck',
    ]);
  });

  it('refuses when the file was re-uploaded between the read and the write', async () => {
    await seed(BLOCKED);
    await clear(MOD_A, 'first clear');
    const read = dbMock.dbWrite.file.findUnique.getMockImplementation()!;
    dbMock.dbWrite.file.findUnique.mockImplementationOnce((async (args: never) => {
      const seen = await read(args);
      await db.query(`UPDATE "File" SET url = 'https://storage.example.com/u/31-new'`);
      return seen;
    }) as never);

    await expect(reblock(MOD_A, 'stale page')).rejects.toThrow(
      'This file changed while you were reviewing it.'
    );
    expect((await activities()).map((a) => a.activity.split(':')[0])).toEqual(['clearFileCheck']);
  });

  it('rolls the File write back when its ModActivity row cannot be written', async () => {
    await seed(BLOCKED);
    await clear(MOD_A, 'their own alt account');
    const cleared = await fileRow();
    await db.exec(
      `ALTER TABLE "ModActivity" ADD CONSTRAINT no_reblock CHECK (activity NOT LIKE 'reblock%')`
    );

    await expect(reblock(MOD_A, 'the alt claim did not hold up')).rejects.toThrow();
    expect(await fileRow()).toBe(cleared);
  });
});
