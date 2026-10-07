import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { lockBountyForPayout } from '~/server/services/bounty-payout-lock';
import { isTextScanPoiHidden } from '~/server/services/text-scan/flag-snapshot';
import { Availability } from '~/shared/utils/prisma/enums';

// Booting PGlite (WASM Postgres) can exceed the default 10s hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// The payout paths decide "hidden by a text-scan poi flag" from the locked row, and `meta` and
// `details` are both jsonb on Bounty: a statement reading the wrong one type-checks, and every
// hand-written fake returns whatever the test put in it. Only the real statement on real rows
// can tell them apart.

const holder = { db: null as unknown as PGlite };
const tx = {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    return holder.db.query(flat.text, flat.values as unknown[]).then((r) => r.rows);
  },
} as unknown as Prisma.TransactionClient;

const OPEN_POI = { textScanFlags: { poi: { workflowId: 'wf', reason: 'r', textHash: 'h' } } };

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "Availability" AS ENUM (${Object.values(Availability)
      .map((a) => `'${a}'`)
      .join(', ')});
    CREATE TABLE "Bounty" (
      "id"           integer PRIMARY KEY,
      "userId"       integer,
      "complete"     boolean NOT NULL DEFAULT false,
      "refunded"     boolean NOT NULL DEFAULT false,
      "poi"          boolean NOT NULL DEFAULT false,
      "availability" "Availability" NOT NULL DEFAULT 'Public',
      "details"      jsonb,
      "meta"         jsonb,
      "payoutRecordedAt" timestamp(3),
      "payoutSettledAt"  timestamp(3),
      "payoutWinnerUserId" integer
    );
    INSERT INTO "Bounty" ("id", "userId", "poi", "availability", "details", "meta") VALUES
      (1, 5, true, 'Private', '{"baseModel":"SDXL"}', '${JSON.stringify(OPEN_POI)}'),
      (2, 5, true, 'Private', '${JSON.stringify(OPEN_POI)}', NULL);
  `);
});

describe('lockBountyForPayout on real rows', () => {
  it('returns meta, so an open text-scan poi flag reads as hidden', async () => {
    const locked = await lockBountyForPayout(tx, 1);
    expect(locked).toMatchObject({
      userId: 5,
      complete: false,
      refunded: false,
      poi: true,
      payoutRecordedAt: null,
      payoutSettledAt: null,
      payoutWinnerUserId: null,
    });
    expect(isTextScanPoiHidden(locked!)).toBe(true);
  });

  // The mirror case: a flag-shaped `details` must not read as a flag.
  it('does not read details as meta', async () => {
    const locked = await lockBountyForPayout(tx, 2);
    expect(isTextScanPoiHidden(locked!)).toBe(false);
  });

  it('returns null for a missing bounty', async () => {
    expect(await lockBountyForPayout(tx, 999)).toBeNull();
  });
});
