import { describe, expect, it, vi } from 'vitest';
import {
  abuseReportInput,
  MAX_FINDINGS_PER_REPORT,
  MAX_REASON_LENGTH,
  type AbuseReportInput,
} from '@civitai/moderation';
import { serverSchema } from '~/env/server-schema';
import { ringThresholdsFromEnv } from '~/server/jobs/blue-buzz-paid-access-detection';
import {
  BLUE_PAID_ACCESS_DETECTOR,
  buyerPairsSql,
  type BuyerPair,
  type DetectionClickhouse,
  type Ring,
  type RingBuyer,
} from '../detect';
import { PROPOSED_ACTION, toFinding } from '../report';
import { ringsWithinCap, runBluePaidAccessDetection, type RunDeps } from '../run';

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
  const logs: [string, Record<string, unknown>][] = [];
  const result = await runBluePaidAccessDetection({
    ch: ch.port,
    thresholds: t,
    sendReport: async (r) => void reports.push(r),
    now: () => NOW,
    log: (name, data) => void logs.push([name, data]),
  });
  expect(reports).toHaveLength(1);
  return { result, report: reports[0], queries: ch.queries, logs };
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
    expect(report.counters).toEqual({
      pairs: 8,
      rings: 1,
      buyers_detected: 7,
      buyers_filed: 7,
      findings_dropped: 0,
      window_days: 7,
      min_buyers: 5,
      min_share_pct: 80,
    });
    expect(report.summary).toBe(
      '1 creator with at least 5 Blue Buzz paid-access buyers each sending at least 80% of their spend to them, and a purchase in the last day; 7 buyers filed. 8 creator-buyer pairs read over 7 days.'
    );
  });

  it('files a buyer at exactly the share threshold and not one just below it', async () => {
    // Seven buyers at or above 80%, so the ring clears the buyer count either way and only the
    // share comparison decides whether 404 is filed.
    const SHARE_CREATOR = 9004;
    const { report } = await run([
      pair(SHARE_CREATOR, 401, 6_000, 6_000, 3, 2),
      pair(SHARE_CREATOR, 402, 5_500, 6_000, 2, 2),
      pair(SHARE_CREATOR, 403, 4_500, 5_000, 4, 3),
      pair(SHARE_CREATOR, 404, 4_000, 5_000, 2, 1), // exactly 80%
      pair(SHARE_CREATOR, 405, 3_950, 5_000, 2, 1), // 79%
      pair(SHARE_CREATOR, 406, 3_000, 3_200, 5, 4),
      pair(SHARE_CREATOR, 407, 2_600, 2_700, 1, 1),
      pair(SHARE_CREATOR, 408, 1_900, 2_100, 6, 5),
    ]);
    expect(report.findings.map((f) => f.userId)).toEqual([401, 402, 403, 404, 406, 407, 408]);
    expect(report.findings.find((f) => f.userId === 404)?.reason).toContain(
      '80% of the 5,000 Blue Buzz'
    );
  });

  it('files whole rings up to the per-report cap and counts what it dropped', async () => {
    // Rings of 400, 500 and 600 buyers, read smallest first. Largest-first, the 600 and the 400 fill
    // the cap exactly and the 500 is dropped whole rather than split; in read order the 400 and 500
    // would be filed instead, so this also pins the size ordering.
    const sizes = { 9301: 400, 9302: 500, 9303: 600 };
    const pairs = Object.entries(sizes).flatMap(([creator, n], r) =>
      Array.from({ length: n }, (_, i) =>
        pair(Number(creator), 100_000 * (r + 1) + i, 1_000, 1_000, 1, 1)
      )
    );
    const { report, result, logs } = await run(pairs);

    expect(abuseReportInput.safeParse(report).success).toBe(true);
    expect(result).toEqual({ pairs: 1_500, rings: 3, reported: MAX_FINDINGS_PER_REPORT });
    const perGroup = new Map<string, number>();
    for (const f of report.findings)
      perGroup.set(String(f.groupKey), (perGroup.get(String(f.groupKey)) ?? 0) + 1);
    expect(Object.fromEntries(perGroup)).toEqual({
      'blue-paid-access:9303': 600,
      'blue-paid-access:9301': 400,
    });
    expect(report.counters).toMatchObject({
      rings: 3,
      buyers_detected: 1_500,
      buyers_filed: 1_000,
      findings_dropped: 500,
    });
    expect(report.summary).toContain(
      '1,500 buyers found and 1,000 filed; the other 500 did not fit in one report (1,000 findings at most) and are not filed.'
    );
    expect(logs).toContainEqual([
      'blue-buzz-paid-access-truncated',
      { buyers_detected: 1_500, buyers_filed: 1_000, rings_detected: 3, rings_filed: 2 },
    ]);
  });

  it('cuts a single ring larger than the cap, and its reasons still describe the whole ring', async () => {
    const pairs = Array.from({ length: 1_003 }, (_, i) =>
      pair(9305, 500_000 + i, 1_000, 1_000, 1, 1)
    );
    const { report, result } = await run(pairs);

    expect(abuseReportInput.safeParse(report).success).toBe(true);
    expect(result.reported).toBe(MAX_FINDINGS_PER_REPORT);
    expect(report.counters).toMatchObject({ buyers_filed: 1_000, findings_dropped: 3 });
    expect(report.findings[0].reason).toContain('One of 1003 accounts');
    expect(report.findings[0].reason).toContain('0 other Blue Buzz buyers');
  });

  it('skips, rather than cuts, a ring larger than the cap once another ring is filed', () => {
    const ring = (creatorId: number, n: number) =>
      ({
        creatorId,
        buyers: Array.from({ length: n }, (_, i) => ({ buyerId: i })),
      } as unknown as Ring);
    const filed = ringsWithinCap([ring(9401, 3), ring(9402, 12), ring(9403, 4)], 10);
    expect(filed.map((f) => [f.ring.creatorId, f.buyers.length])).toEqual([
      [9401, 3],
      [9403, 4],
    ]);
  });

  it('truncates a reason past MAX_REASON_LENGTH and keeps the proposed action', () => {
    // Only absurd magnitudes make the reason this long; they are what reach the cut.
    const big = Number.MAX_VALUE;
    const d = at('2026-11-01T00:00:00Z');
    const buyer: RingBuyer = {
      ...pair(big, 1, big, big, big, big, d, d),
      sharePct: 100,
    };
    const longRing: Ring = {
      creatorId: big,
      buyers: [buyer],
      allBuyers: big,
      spent: big,
      purchases: big,
      firstAt: d,
      lastAt: d,
    };
    const finding = toFinding(longRing, buyer, { windowDays: 7, minSharePct: 80 });

    expect(finding.reason).toHaveLength(MAX_REASON_LENGTH);
    expect(finding.reason.endsWith(`…\n${PROPOSED_ACTION}`)).toBe(true);
    const report: AbuseReportInput = {
      detector: BLUE_PAID_ACCESS_DETECTOR,
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      findings: [finding],
    };
    expect(abuseReportInput.safeParse(report).success).toBe(true);
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
