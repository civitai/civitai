import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { BlockedReason } from '~/server/common/enums';
import { ownerMediaAllowed } from '~/server/common/image-block-marker';
import {
  ownerMediaAllowedSql,
  ownerMediaAllowedWhere,
  ownerMediaSql,
} from '~/server/common/image-visibility';

/**
 * `ownerMediaAllowed` and its two database encodings answer every cell of one matrix alike: each
 * ingestion state against every block reason, a reason no code writes ('zzz') and none. Only no
 * block, or the metadata hold alone, leaves the owner the media.
 */
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const INGESTIONS = ['Scanned', 'Pending', 'Error', 'Blocked', 'Rescan'] as const;
const REASONS = [
  null,
  BlockedReason.AiNotVerified,
  BlockedReason.TOS,
  BlockedReason.Moderated,
  BlockedReason.CSAM,
  'zzz',
] as const;
const CELLS = INGESTIONS.flatMap((ingestion) =>
  REASONS.map((blockedFor) => ({ ingestion, blockedFor }))
).map((cell, i) => ({ id: i + 1, ...cell }));

const OWNER = 1;
const STRANGER = 2;

let h: Awaited<ReturnType<typeof startPglitePrisma>>;

beforeAll(async () => {
  h = await startPglitePrisma(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT ${OWNER},
      ingestion "ImageIngestionStatus" NOT NULL, "blockedFor" text
    );
  `);
  for (const { id, ingestion, blockedFor } of CELLS)
    await h.prisma.$executeRaw`INSERT INTO "Image" (id, ingestion, "blockedFor")
      VALUES (${id}, ${ingestion}::"ImageIngestionStatus", ${blockedFor})`;
});
afterAll(() => h?.stop());

const sqlAllowed = async (where: Prisma.Sql) =>
  (
    await h.prisma.$queryRaw<
      { id: number }[]
    >`SELECT i.id FROM "Image" i WHERE ${where} ORDER BY i.id`
  ).map((r) => r.id);

const tsAllowed = () => CELLS.filter((cell) => ownerMediaAllowed(cell)).map((c) => c.id);

describe('ownerMediaAllowed', () => {
  it('leaves the owner the media only with no block, or the metadata hold alone', () => {
    const allowed = CELLS.filter((cell) => ownerMediaAllowed(cell)).map(
      ({ ingestion, blockedFor }) => `${ingestion}/${blockedFor}`
    );
    expect(allowed).toEqual([
      'Scanned/null',
      'Scanned/AiNotVerified',
      'Pending/null',
      'Pending/AiNotVerified',
      'Error/null',
      'Error/AiNotVerified',
      'Blocked/AiNotVerified',
      'Rescan/null',
      'Rescan/AiNotVerified',
    ]);
  });

  it('agrees with its SQL twin on every cell, an unknown reason included', async () => {
    expect(await sqlAllowed(ownerMediaAllowedSql())).toEqual(tsAllowed());
  });

  it('agrees with its Prisma filter on every cell', async () => {
    const rows = await h.prisma.image.findMany({
      where: ownerMediaAllowedWhere(),
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((r) => r.id)).toEqual(tsAllowed());
  });
});

describe('ownerMediaSql', () => {
  it('holds the owner to the rule and leaves everyone else to the caller', async () => {
    expect(await sqlAllowed(ownerMediaSql(OWNER))).toEqual(tsAllowed());
    expect(await sqlAllowed(ownerMediaSql(STRANGER))).toEqual(CELLS.map((c) => c.id));
    expect(await sqlAllowed(ownerMediaSql(undefined))).toEqual(CELLS.map((c) => c.id));
  });
});
