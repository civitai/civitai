import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { BountySort } from '~/server/common/enums';
import { getAllBounties } from '~/server/services/bounty.service';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const SCHEMA = `
  CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
  CREATE TABLE "Bounty" (id int PRIMARY KEY, "userId" int, availability "Availability" NOT NULL,
    "createdAt" timestamp(3) NOT NULL);
  INSERT INTO "Bounty" VALUES
    (1, 7, 'Public', '2026-11-01'), (2, 7, 'Public', '2026-11-02'), (3, 7, 'Public', '2026-11-03'),
    (4, 7, 'Public', '2026-11-04'), (5, 7, 'Public', '2026-11-05');
`;

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;

beforeAll(async () => {
  harness = await startPglitePrisma(SCHEMA);
  dbMock.dbRead.bounty.findMany.mockImplementation(((args: never) =>
    harness.prisma.bounty.findMany(args)) as never);
});

afterAll(async () => {
  await harness?.stop();
});

describe('getAllBounties ids', () => {
  // Semantic search hydrates its ranked ids through the feed query with limit = ids.length.
  it('returns exactly the given bounties, not the newest rows', async () => {
    const rows = await getAllBounties({
      input: {
        ids: [1, 3],
        limit: 3,
        period: MetricTimeframe.AllTime,
        sort: BountySort.Newest,
      },
      select: { id: true },
    });
    expect(rows.map((r) => r.id).sort()).toEqual([1, 3]);
  });
});
