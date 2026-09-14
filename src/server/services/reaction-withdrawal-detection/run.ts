import type { AbuseReportInput } from '@civitai/moderation';
import {
  describeAccounts,
  findWithdrawalCandidates,
  REACTION_WITHDRAWAL_DETECTOR,
  type DetectionClickhouse,
  type WithdrawalAccount,
} from './detect';
import { renderSummary, toFinding } from './report';

export type RunDeps = {
  /**
   * 🔴 NULLABLE BECAUSE THE REAL CLIENT IS. `~/server/clickhouse/client` exports `undefined` on any
   * deployment without `CLICKHOUSE_HOST`, and this detector's only source is ClickHouse. That is a
   * supported state, not an error — the run reports it and files nothing, rather than filing an
   * empty run that reads as "we looked and found nobody".
   */
  ch: DetectionClickhouse | null;
  sendReport: (report: AbuseReportInput) => Promise<unknown>;
  now: () => Date;
  log?: (name: string, data: Record<string, unknown>) => void;
};

export type RunResult = {
  scanned: number;
  reported: number;
  skipped?: 'clickhouse-unavailable';
};

export async function runReactionWithdrawalDetection(deps: RunDeps): Promise<RunResult> {
  const startedAt = deps.now();

  if (!deps.ch) {
    deps.log?.('reaction-withdrawal-skipped', { reason: 'clickhouse-unavailable' });
    return { scanned: 0, reported: 0, skipped: 'clickhouse-unavailable' };
  }

  const candidates = await findWithdrawalCandidates(deps.ch);
  const accounts: WithdrawalAccount[] = await describeAccounts(candidates, { now: startedAt });

  // Strongest evidence first, matching the order the board will render them in — so a truncated
  // report loses the weakest rows rather than an arbitrary slice.
  accounts.sort((a, b) => b.cycles / Math.max(1, b.given) - a.cycles / Math.max(1, a.given));

  const report: AbuseReportInput = {
    detector: REACTION_WITHDRAWAL_DETECTOR,
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
    summary: renderSummary(accounts, candidates.length),
    counters: {
      matched_pattern: candidates.length,
      live_accounts: accounts.length,
      withdrawals: accounts.reduce((sum, a) => sum + a.cycles, 0),
    },
    findings: accounts.map(toFinding),
  };

  // Filed even with no findings: a run row with zero findings is how the board says "this detector
  // ran and found nothing", which is a different and necessary claim from the detector having gone
  // quiet. `counters` carries the population it looked at either way.
  await deps.sendReport(report);
  deps.log?.('reaction-withdrawal-reported', {
    scanned: candidates.length,
    reported: accounts.length,
  });

  return { scanned: candidates.length, reported: accounts.length };
}
