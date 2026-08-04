import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Behavioral tests for the `civitai_app_challenge_completing_stuck` PREDICATE.
 *
 * Why this file exists separately from challenge.metrics.test.ts: that file is, by its own header,
 * a pure unit test that never boots the DB, and it drives the gauges through
 * `__setChallengeGaugeCacheForTest` — which injects the rows a query WOULD have returned. That mocks
 * at the wrong layer to defend a `WHERE` clause: it cannot distinguish a correct predicate from a
 * broken one, which is exactly how the `updatedAt` defect shipped and survived a test suite.
 *
 * So this file runs the REAL, unmodified gauge SQL against an in-process Postgres (PGlite, the same
 * WASM Postgres the listForModel behavior suite uses), seeds real `Challenge` rows, and asserts on
 * the Prometheus series the gauge actually emits.
 *
 * The defect being pinned: `Challenge.updatedAt` is a Prisma-side `@updatedAt`, but the ONLY writer
 * of `status = 'Completing'` is the raw-SQL `claimChallengeForCompletion`, so entering `Completing`
 * never bumps `updatedAt`. The old predicate therefore fired the instant a day-old challenge was
 * claimed (false positive) and went quiet whenever an unrelated Prisma write touched a genuinely
 * stalled one (false negative). Both directions are asserted below; reverting the predicate to
 * `"updatedAt" < now() - interval '30 minutes'` fails these tests.
 */

// Booting PGlite (WASM Postgres) can exceed the default 10s hook timeout on a slow/contended CI
// node. Generous, env-agnostic timeouts — relaxing a timeout can only help a slow runner, never mask
// a real failure. Mirrors listForModel.behavior.test.ts.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// A single mutable holder created during hoisting lets the (also-hoisted) vi.mock factory reference
// a PGlite instance that is only assigned in beforeAll — the factory closes over `holder`.
const holder = vi.hoisted(() => ({ db: null as unknown as import('@electric-sql/pglite').PGlite }));

// The gauge query does `await import('~/server/db/pgDb')` then `pgDbRead.connect()`, and uses only
// `.query(sql)` / `.release()`. Bridge those onto PGlite so the production SQL runs unmodified.
vi.mock('~/server/db/pgDb', async () => {
  const { createPgDbMock } = await import('~/test-utils/pgDbMock');
  return createPgDbMock({
    pgDbRead: {
      connect: async () => ({
        query: (sql: string) => holder.db.query(sql),
        release: () => undefined,
      }),
    },
  });
});

import {
  __refreshChallengeGaugesFromDbForTest,
  __setChallengeGaugeCacheForTest,
} from '~/server/prom/challenge.metrics';
import client from 'prom-client';

const GAUGE = 'civitai_app_challenge_completing_stuck';

type MetricJSON = { values: { value: number; labels: Record<string, string> }[] };

/**
 * The emitted series list for the gauge, as sorted [source, value] pairs.
 *
 * Asserted as a WHOLE LIST, never via a `find(...) ?? 0` lookup: that helper defaults a missing
 * series to 0, so it cannot tell "the query correctly excluded this row" from "the query blew up and
 * emitted nothing" — the two outcomes this file has to keep apart.
 */
async function sourcePairs(): Promise<[string, number][]> {
  const metric = client.register.getSingleMetric(GAUGE) as unknown as {
    get: () => Promise<MetricJSON>;
  };
  const { values } = await metric.get();
  return values
    .map((v) => [v.labels.source, v.value] as [string, number])
    // Codepoint sort (NOT localeCompare — locale-dependent ordering would make this assertion
    // machine-dependent).
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** ISO-8601 UTC stamp `minutesAgo` in the past, in the exact shape the claim writes. */
function claimStamp(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

type SeedRow = {
  source: 'System' | 'Mod' | 'User';
  status?: 'Active' | 'Completing' | 'Completed';
  /** Raw text stored at metadata.completingClaimedAt; `null` = key absent entirely. */
  claimedAt: string | null;
  /** How long ago the Prisma-side `@updatedAt` column was last written. */
  updatedAtMinutesAgo: number;
};

async function seed(rows: SeedRow[]): Promise<void> {
  for (const r of rows) {
    const metadata =
      r.claimedAt === null
        ? `'{}'::jsonb`
        : `jsonb_build_object('completingClaimedAt', '${r.claimedAt}'::text)`;
    await holder.db.query(
      `INSERT INTO "Challenge" (source, status, metadata, "updatedAt")
       VALUES ('${r.source}', '${r.status ?? 'Completing'}', ${metadata},
               now() - interval '${r.updatedAtMinutesAgo} minutes')`
    );
  }
}

beforeAll(async () => {
  holder.db = new PGlite();
  // Only the enums/columns the four gauge queries actually read.
  await holder.db.exec(`
    CREATE TYPE "ChallengeSource" AS ENUM ('System','Mod','User');
    CREATE TYPE "ChallengeStatus" AS ENUM ('Scheduled','Active','Completing','Completed','Cancelled');
    CREATE TYPE "ChallengeIngestionStatus" AS ENUM ('Pending','Scanned','Blocked','Error');
    CREATE TABLE "Challenge" (
      id                serial PRIMARY KEY,
      source            "ChallengeSource" NOT NULL DEFAULT 'System',
      status            "ChallengeStatus" NOT NULL DEFAULT 'Scheduled',
      ingestion         "ChallengeIngestionStatus" NOT NULL DEFAULT 'Scanned',
      metadata          jsonb,
      "operationBudget" integer NOT NULL DEFAULT 0,
      "operationSpent"  integer NOT NULL DEFAULT 0,
      "updatedAt"       timestamptz NOT NULL DEFAULT now()
    );
  `);
});

beforeEach(async () => {
  await holder.db.query(`TRUNCATE "Challenge"`);
  // Clear any series left by a previous case so an assertion can never read a stale emit.
  __setChallengeGaugeCacheForTest({});
});

describe('completing_stuck predicate — real SQL against real Postgres', () => {
  it('does NOT count a freshly claimed challenge whose updatedAt is a day old (the shipped false positive)', async () => {
    // Exactly the production shape: a daily challenge last written by Prisma ~24h ago, claimed into
    // Completing seconds ago by the raw-SQL claim (which does not bump updatedAt). This is healthy —
    // the normal completion window is ~25-30s. The `updatedAt` predicate counted it immediately,
    // which is the 00:00-00:01 UTC blip observed on 5 consecutive days.
    await seed([{ source: 'System', claimedAt: claimStamp(1), updatedAtMinutesAgo: 24 * 60 }]);
    await __refreshChallengeGaugesFromDbForTest();

    expect(await sourcePairs()).toEqual([
      ['Mod', 0],
      ['System', 0],
      ['User', 0],
    ]);
  });

  it('counts a challenge claimed longer ago than the threshold, even if updatedAt was just bumped', async () => {
    // The other direction the old predicate got wrong: a genuinely deadlocked run whose row was
    // touched by an unrelated Prisma write (e.g. the prizes recompute, which runs while the row is
    // Completing) had its `updatedAt` clock reset and went invisible.
    await seed([{ source: 'Mod', claimedAt: claimStamp(45), updatedAtMinutesAgo: 0 }]);
    await __refreshChallengeGaugesFromDbForTest();

    expect(await sourcePairs()).toEqual([
      ['Mod', 1],
      ['System', 0],
      ['User', 0],
    ]);
  });

  it('counts a Completing challenge with NO claim stamp as stuck', async () => {
    // A stampless Completing row is the least recoverable state in the system:
    // resetStuckCompletingChallenges compares `(metadata->>'completingClaimedAt')::timestamptz`,
    // which is NULL-propagating, so it never selects — the row stays Completing forever. Counting it
    // is the deliberate choice; treating it as healthy would make the gauge blind to the one state
    // that provably cannot self-heal.
    await seed([{ source: 'User', claimedAt: null, updatedAtMinutesAgo: 0 }]);
    await __refreshChallengeGaugesFromDbForTest();

    expect(await sourcePairs()).toEqual([
      ['Mod', 0],
      ['System', 0],
      ['User', 1],
    ]);
  });

  it('counts a malformed claim stamp as stuck WITHOUT the query raising', async () => {
    // `('not-a-timestamp')::timestamptz` raises in Postgres. Had the predicate cast, this row would
    // fail the whole gauge read, the never-throw catch would swallow it, and all four gauges would
    // silently freeze on last-good values. `__refreshChallengeGaugesFromDbForTest` deliberately does
    // not swallow, so a regression to a casting predicate surfaces here as a thrown error rather
    // than as a wrong number.
    await seed([{ source: 'User', claimedAt: 'not-a-timestamp', updatedAtMinutesAgo: 0 }]);
    await expect(__refreshChallengeGaugesFromDbForTest()).resolves.toBeUndefined();

    expect(await sourcePairs()).toEqual([
      ['Mod', 0],
      ['System', 0],
      ['User', 1],
    ]);
  });

  it('a well-formed stamp in a different ISO shape is treated as unusable, not mis-ordered', async () => {
    // Second-precision ISO ('...T00:00:00Z') is chronologically ancient but sorts AFTER the
    // millisecond-precision threshold ('Z' > '.'), so a naive text comparison would call it fresh.
    // The shape regex catches it first and it lands in the "no usable stamp" branch instead.
    await seed([{ source: 'User', claimedAt: '2020-01-01T00:00:00Z', updatedAtMinutesAgo: 0 }]);
    await __refreshChallengeGaugesFromDbForTest();

    expect(await sourcePairs()).toEqual([
      ['Mod', 0],
      ['System', 0],
      ['User', 1],
    ]);
  });

  it('only Completing rows are considered, and counts split by source', async () => {
    await seed([
      // Stuck, counted.
      { source: 'System', claimedAt: claimStamp(90), updatedAtMinutesAgo: 0 },
      { source: 'User', claimedAt: claimStamp(31), updatedAtMinutesAgo: 0 },
      { source: 'User', claimedAt: null, updatedAtMinutesAgo: 0 },
      // Claimed inside the window — healthy.
      { source: 'Mod', claimedAt: claimStamp(5), updatedAtMinutesAgo: 24 * 60 },
      // Not Completing at all: an ancient stamp left behind on a finished/never-claimed row must not
      // leak into the count.
      { source: 'Mod', status: 'Completed', claimedAt: claimStamp(600), updatedAtMinutesAgo: 24 * 60 },
      { source: 'Mod', status: 'Active', claimedAt: null, updatedAtMinutesAgo: 24 * 60 },
    ]);
    await __refreshChallengeGaugesFromDbForTest();

    expect(await sourcePairs()).toEqual([
      ['Mod', 0],
      ['System', 1],
      ['User', 2],
    ]);
  });

  it('emits an explicit 0 per source when nothing is Completing (zero-emit survives the fix)', async () => {
    await seed([{ source: 'System', status: 'Active', claimedAt: null, updatedAtMinutesAgo: 0 }]);
    await __refreshChallengeGaugesFromDbForTest();

    expect(await sourcePairs()).toEqual([
      ['Mod', 0],
      ['System', 0],
      ['User', 0],
    ]);
  });
});
