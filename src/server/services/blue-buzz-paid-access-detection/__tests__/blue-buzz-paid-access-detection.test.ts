import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { abuseReportInput, type AbuseReportInput } from '@civitai/moderation';
import { serverSchema } from '~/env/server-schema';
import { ringThresholdsFromEnv } from '~/server/jobs/blue-buzz-paid-access-detection';
import {
  BLUE_PAID_ACCESS_DETECTOR,
  buyerPairsSql,
  type BuyerPair,
  type DetectionClickhouse,
} from '../detect';
import { PROPOSED_ACTION } from '../report';
import { runBluePaidAccessDetection, type RunDeps } from '../run';

const NOW = new Date('2026-11-02T08:00:00Z');
const at = (iso: string) => new Date(iso);

type Env = Parameters<typeof ringThresholdsFromEnv>[0];
/** Thresholds as a deployment gets them: each raw env value through the real schema field. */
function thresholds(raw: Partial<Record<keyof Env, string>> = {}) {
  const parsed = Object.fromEntries(
    (
      [
        'BLUE_PAID_ACCESS_RING_WINDOW_DAYS',
        'BLUE_PAID_ACCESS_RING_MIN_BUYERS',
        'BLUE_PAID_ACCESS_RING_MIN_SHARE_PCT',
      ] as const
    ).map((k) => [k, serverSchema.shape[k].parse(raw[k])])
  ) as Env;
  return ringThresholdsFromEnv(parsed);
}

function pair(
  creatorId: number,
  buyerId: number,
  spent: number,
  buyerTotal: number,
  purchases: number,
  versions: number,
  firstAt = at('2026-10-31T10:00:00Z'),
  lastAt = at('2026-11-01T22:15:00Z')
): BuyerPair {
  return { creatorId, buyerId, spent, buyerTotal, purchases, versions, firstAt, lastAt };
}

/** ClickHouse rows are strings and epoch seconds, as the real client returns them. */
const toRow = (p: BuyerPair) => ({
  ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)])),
  firstAt: String(p.firstAt.getTime() / 1000),
  lastAt: String(p.lastAt.getTime() / 1000),
});

/** A ClickHouse that answers every query with `pairs` and exposes nothing but `$query`. */
function chReturning(pairs: BuyerPair[]) {
  const queries: string[] = [];
  const port: DetectionClickhouse = {
    $query: async <T extends object>(sql: string) => {
      queries.push(sql);
      return pairs.map(toRow) as unknown as T[];
    },
  };
  return { queries, port };
}

async function run(pairs: BuyerPair[], t = thresholds()) {
  const ch = chReturning(pairs);
  const reports: AbuseReportInput[] = [];
  const result = await runBluePaidAccessDetection({
    ch: ch.port,
    thresholds: t,
    sendReport: async (r) => void reports.push(r),
    now: () => NOW,
  });
  expect(reports).toHaveLength(1);
  return { result, report: reports[0], queries: ch.queries };
}

const RING_CREATOR = 9001;
/** Seven buyers each sending 84–100% of their Blue Buzz paid-access spend to one creator, plus one
 *  ordinary buyer of the same creator at 30%. */
const ring = [
  pair(RING_CREATOR, 101, 5_000, 5_000, 4, 3),
  pair(RING_CREATOR, 102, 4_200, 4_400, 3, 2),
  pair(RING_CREATOR, 103, 3_600, 3_900, 2, 1),
  pair(RING_CREATOR, 104, 2_900, 3_300, 5, 4),
  pair(RING_CREATOR, 105, 2_500, 2_950, 6, 5),
  pair(RING_CREATOR, 106, 2_100, 2_300, 7, 6),
  pair(
    RING_CREATOR,
    107,
    1_700,
    1_890,
    8,
    7,
    at('2026-10-30T03:20:00Z'),
    at('2026-11-02T06:45:00Z')
  ),
  pair(RING_CREATOR, 108, 900, 3_000, 1, 1),
];

/** A popular creator whose twelve Blue Buzz buyers each spend a quarter of their spend with them
 *  and the rest with other creators, one buyer each. */
const POPULAR_CREATOR = 9002;
const popular = Array.from({ length: 12 }, (_, i) => {
  const buyer = 201 + i;
  const spent = 1_000 + 37 * i;
  return [
    pair(POPULAR_CREATOR, buyer, spent, spent * 4, 2, 2),
    pair(9100 + i, buyer, spent * 3, spent * 4, 3, 3),
  ];
}).flat();

/** Four concentrated buyers — one fewer than the default — and one at 60%. */
const BOUNDARY_CREATOR = 9003;
const boundary = [
  pair(BOUNDARY_CREATOR, 301, 3_300, 3_300, 3, 2),
  pair(BOUNDARY_CREATOR, 302, 2_700, 2_950, 2, 2),
  pair(BOUNDARY_CREATOR, 303, 2_200, 2_500, 4, 3),
  pair(BOUNDARY_CREATOR, 304, 1_800, 2_100, 5, 4),
  pair(BOUNDARY_CREATOR, 305, 1_200, 2_000, 1, 1),
];

describe('blue-buzz-paid-access detection', () => {
  it('files a coordinated multi-buyer, single-creator Blue Buzz ring as one group', async () => {
    const { report, result } = await run(ring);

    expect(abuseReportInput.safeParse(report).success).toBe(true);
    expect(report.detector).toBe('blue-buzz-paid-access');
    expect(report.detector).toBe(BLUE_PAID_ACCESS_DETECTOR);
    expect(result).toEqual({ pairs: 8, rings: 1, reported: 7 });

    // One finding per concentrated buyer; the 30% buyer is not one of them.
    expect(report.findings.map((f) => f.userId)).toEqual([101, 102, 103, 104, 105, 106, 107]);
    for (const f of report.findings) {
      expect(f.groupKey).toBe('blue-paid-access:9001');
      expect(f.actioned).toBe(false);
      expect(f).not.toHaveProperty('action');
      expect(f.reason.endsWith(`\n${PROPOSED_ACTION}`)).toBe(true);
      expect(f.reason).toContain('creator 9001');
    }

    // Every number the rule used, about this buyer and this ring.
    const reason = report.findings.find((f) => f.userId === 102)?.reason;
    expect(reason).toBe(
      'One of 7 accounts that bought paid access from creator 9001 with Blue Buzz in the last 7 days while sending at least 80% of their Blue Buzz paid-access spend to that creator. ' +
        'This account: 3 purchases of 2 model versions, 4,200 Blue Buzz, 95% of the 4,400 Blue Buzz it spent on paid access, between 2026-10-31 10:00 and 2026-11-01 22:15 UTC. ' +
        'Ring: 22,000 Blue Buzz in 35 purchases between 2026-10-30 03:20 and 2026-11-02 06:45 UTC; 1 other Blue Buzz buyer of this creator spent less than 80% with them and is not included. ' +
        'No action was taken by this scan — filed for a moderator to review.\n' +
        'Proposed action: review these buyers as one ring; consider revoking the paid-access grants they bought from this creator with Blue Buzz.'
    );
    expect(report.counters).toMatchObject({ pairs: 8, rings: 1, buyers: 7 });
  });

  it('files nothing for a popular creator whose buyers spread their spend across creators', async () => {
    const { report, result } = await run(popular);
    expect(abuseReportInput.safeParse(report).success).toBe(true);
    expect(result).toEqual({ pairs: 24, rings: 0, reported: 0 });
    expect(report.findings).toEqual([]);
  });

  it('reads only Blue Buzz paid-access purchases, so green and yellow ones never reach the rule', () => {
    // The currency, type and product filters are in the query, which no fake here executes. Pinned
    // as the wire predicate it is; the shape of the access id comes from the purchase writer.
    const sql = buyerPairsSql({ since: NOW, minBuyers: 5 });
    expect(sql).toContain("fromAccountType = 'blue'");
    expect(sql).not.toMatch(/'(green|yellow)'/);
    expect(sql).toContain("type IN ('purchase','6','unknown_6')");
    expect(sql).toContain("externalTransactionId LIKE 'early-access-%'");
    expect(sql).toContain("externalTransactionId LIKE 'permanent-access-%'");
    expect(sql).toContain('fromAccountId != toAccountId');
  });

  it('files nothing one concentrated buyer below the threshold', async () => {
    const { report, result } = await run(boundary);
    expect(result).toEqual({ pairs: 5, rings: 0, reported: 0 });
    expect(report.findings).toEqual([]);
  });

  it('does not file a ring again once it has stopped buying', async () => {
    const stale = ring.map((p) => ({ ...p, lastAt: at('2026-11-01T07:59:00Z') }));
    const { result } = await run(stale);
    expect(result.reported).toBe(0);
  });

  it('the env overrides change what is filed', async () => {
    // Below the default buyer count: nothing, then four findings with the count lowered to 4.
    expect((await run(boundary)).result.reported).toBe(0);
    const lowered = await run(boundary, thresholds({ BLUE_PAID_ACCESS_RING_MIN_BUYERS: '4' }));
    expect(lowered.report.findings.map((f) => f.userId)).toEqual([301, 302, 303, 304]);
    expect(lowered.report.findings[0].reason).toContain('One of 4 accounts');

    // The popular creator (25% each) becomes a ring when the share is lowered to 24%.
    const share = await run(popular, thresholds({ BLUE_PAID_ACCESS_RING_MIN_SHARE_PCT: '24' }));
    expect(share.result).toMatchObject({ rings: 1, reported: 12 });
    expect(share.report.findings[0].reason).toContain('at least 24%');

    // The window moves the query's start.
    expect((await run([])).queries[0]).toContain("toDateTime('2026-10-26 08:00:00', 'UTC')");
    const wide = await run([], thresholds({ BLUE_PAID_ACCESS_RING_WINDOW_DAYS: '30' }));
    expect(wide.queries[0]).toContain("toDateTime('2026-10-03 08:00:00', 'UTC')");

    // A bad value falls back to the default instead of failing boot.
    expect(thresholds({ BLUE_PAID_ACCESS_RING_MIN_BUYERS: 'abc' }).minBuyers).toBe(5);
    expect(thresholds({ BLUE_PAID_ACCESS_RING_MIN_BUYERS: '1' }).minBuyers).toBe(5);
  });

  it('acts on nothing: its only side effect is the report', async () => {
    const sendReport = vi.fn(async () => undefined);
    const ch = chReturning(ring);
    // Any read of a dependency other than the ones below throws.
    const guard = <T extends object>(target: T, allowed: string[]) =>
      new Proxy(target, {
        get(t, key) {
          if (typeof key === 'string' && !allowed.includes(key))
            throw new Error(`unexpected access: ${key}`);
          return Reflect.get(t, key);
        },
      });
    const deps = guard<RunDeps>(
      {
        ch: guard(ch.port, ['$query']),
        thresholds: thresholds(),
        sendReport,
        now: () => NOW,
      },
      ['ch', 'thresholds', 'sendReport', 'now', 'log']
    );

    await runBluePaidAccessDetection(deps);
    expect(sendReport).toHaveBeenCalledTimes(1);
    expect(ch.queries).toHaveLength(1);
  });

  it('imports no module that could act on an account', () => {
    const dir = path.resolve(__dirname, '..');
    const imports = ['detect.ts', 'report.ts', 'run.ts'].flatMap((f) =>
      [...readFileSync(path.join(dir, f), 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1])
    );
    expect([...new Set(imports)].sort()).toEqual([
      '../abuse-report-prose',
      './detect',
      './report',
      '@civitai/moderation',
      '~/server/clickhouse/client',
      '~/server/clickhouse/transaction-type',
      '~/shared/constants/buzz.constants',
    ]);
  });

  it('files nothing and sends nothing without ClickHouse', async () => {
    const sendReport = vi.fn();
    const result = await runBluePaidAccessDetection({
      ch: null,
      thresholds: thresholds(),
      sendReport,
      now: () => NOW,
    });
    expect(result.skipped).toBe('clickhouse-unavailable');
    expect(sendReport).not.toHaveBeenCalled();
  });
});
