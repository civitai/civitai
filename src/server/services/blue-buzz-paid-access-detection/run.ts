import { MAX_FINDINGS_PER_REPORT, type AbuseReportInput } from '@civitai/moderation';
import {
  BLUE_PAID_ACCESS_DETECTOR,
  findBuyerPairs,
  findRings,
  PAIR_CEILING,
  RUN_INTERVAL_HOURS,
  type DetectionClickhouse,
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
  const findings = rings
    .flatMap((ring) => ring.buyers.map((buyer) => toFinding(ring, buyer, thresholds)))
    .slice(0, MAX_FINDINGS_PER_REPORT);

  // Filed with no findings too: a run row is how the board shows the detector ran.
  await deps.sendReport({
    detector: BLUE_PAID_ACCESS_DETECTOR,
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
    summary: renderSummary(rings, pairs.length, thresholds),
    counters: {
      pairs: pairs.length,
      rings: rings.length,
      buyers: rings.reduce((sum, r) => sum + r.buyers.length, 0),
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
