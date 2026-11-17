import { MAX_FINDINGS_PER_REPORT, type AbuseReportInput } from '@civitai/moderation';
import {
  BLUE_PAID_ACCESS_DETECTOR,
  findBuyerPairs,
  findRings,
  PAIR_CEILING,
  RUN_INTERVAL_HOURS,
  type DetectionClickhouse,
  type Ring,
  type RingThresholds,
} from './detect';
import { renderSummary, toFinding } from './report';

export type RunDeps = {
  /** Null on a deployment without ClickHouse: the run files nothing rather than an empty run that
   *  reads as "we looked and found nobody". */
  ch: DetectionClickhouse | null;
  thresholds: RingThresholds;
  sendReport: (report: AbuseReportInput) => Promise<unknown>;
  now: () => Date;
  log?: (name: string, data: Record<string, unknown>) => void;
};

export type RunResult = {
  pairs: number;
  rings: number;
  reported: number;
  skipped?: 'clickhouse-unavailable';
};

export async function runBluePaidAccessDetection(deps: RunDeps): Promise<RunResult> {
  const startedAt = deps.now();
  const { thresholds } = deps;

  if (!deps.ch) {
    deps.log?.('blue-buzz-paid-access-skipped', { reason: 'clickhouse-unavailable' });
    return { pairs: 0, rings: 0, reported: 0, skipped: 'clickhouse-unavailable' };
  }

  const pairs = await findBuyerPairs(deps.ch, {
    since: new Date(startedAt.getTime() - thresholds.windowDays * 86_400_000),
    minBuyers: thresholds.minBuyers,
  });
  if (pairs.length >= PAIR_CEILING)
    deps.log?.('blue-buzz-paid-access-ceiling', { pairs: pairs.length });

  const rings = findRings(pairs, {
    minBuyers: thresholds.minBuyers,
    minSharePct: thresholds.minSharePct,
    activeSince: new Date(startedAt.getTime() - RUN_INTERVAL_HOURS * 3_600_000),
  });
  const filed = ringsWithinCap(rings);
  const findings = filed.flatMap(({ ring, buyers }) =>
    buyers.map((buyer) => toFinding(ring, buyer, thresholds))
  );
  const detected = rings.reduce((sum, r) => sum + r.buyers.length, 0);
  if (findings.length < detected)
    deps.log?.('blue-buzz-paid-access-truncated', {
      buyers_detected: detected,
      buyers_filed: findings.length,
      rings_detected: rings.length,
      rings_filed: filed.length,
    });

  // Filed with no findings too: a run row is how the board shows the detector ran.
  await deps.sendReport({
    detector: BLUE_PAID_ACCESS_DETECTOR,
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
    summary: renderSummary(rings, findings.length, pairs.length, thresholds),
    counters: {
      pairs: pairs.length,
      rings: rings.length,
      buyers_detected: detected,
      buyers_filed: findings.length,
      findings_dropped: detected - findings.length,
      window_days: thresholds.windowDays,
      min_buyers: thresholds.minBuyers,
      min_share_pct: thresholds.minSharePct,
    },
    findings,
  });
  deps.log?.('blue-buzz-paid-access-reported', {
    pairs: pairs.length,
    rings: rings.length,
    reported: findings.length,
  });

  return { pairs: pairs.length, rings: rings.length, reported: findings.length };
}

/** The buyers filed under the per-report cap, ring by ring in the order given. A ring that fits is
 *  filed whole and one that does not is skipped, so a smaller ring may take the room. A ring bigger
 *  than the whole cap is cut to its first `cap` buyers only when it is the first to be filed; after
 *  that it is skipped. A cut ring's reasons still describe the whole ring. */
export function ringsWithinCap(
  rings: Ring[],
  cap = MAX_FINDINGS_PER_REPORT
): { ring: Ring; buyers: Ring['buyers'] }[] {
  const filed: { ring: Ring; buyers: Ring['buyers'] }[] = [];
  let room = cap;
  for (const ring of rings) {
    if (ring.buyers.length <= room) {
      filed.push({ ring, buyers: ring.buyers });
      room -= ring.buyers.length;
    } else if (room === cap) {
      filed.push({ ring, buyers: ring.buyers.slice(0, cap) });
      room = 0;
    }
  }
  return filed;
}
