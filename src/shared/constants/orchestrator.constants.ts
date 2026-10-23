import { NsfwLevel, WorkflowStatus } from '@civitai/orchestration-client';

export const PENDING_STATUSES: WorkflowStatus[] = [
  WorkflowStatus.UNASSIGNED,
  WorkflowStatus.PREPARING,
  WorkflowStatus.SCHEDULED,
];

export const POLLABLE_STATUSES: WorkflowStatus[] = [...PENDING_STATUSES, WorkflowStatus.PROCESSING];

export const COMPLETE_STATUSES: WorkflowStatus[] = [
  WorkflowStatus.SUCCEEDED,
  WorkflowStatus.FAILED,
  WorkflowStatus.EXPIRED,
  WorkflowStatus.CANCELED,
];

const matureNsfwLevels: NsfwLevel[] = [NsfwLevel.R, NsfwLevel.X, NsfwLevel.XXX];
const privateGenNsfwLevels: NsfwLevel[] = [NsfwLevel.PG, NsfwLevel.PG13];
const nsfwLevelSeverity: NsfwLevel[] = [
  NsfwLevel.PG,
  NsfwLevel.PG13,
  NsfwLevel.R,
  NsfwLevel.X,
  NsfwLevel.XXX,
];

/** Most severe rated level among the inputs (unrated / 'na' ignored). */
export function maxNsfwLevel(levels: Array<NsfwLevel | null | undefined>): NsfwLevel | undefined {
  let max = -1;
  for (const level of levels) {
    if (!level) continue;
    const rank = nsfwLevelSeverity.indexOf(level);
    if (rank > max) max = rank;
  }
  return max >= 0 ? nsfwLevelSeverity[max] : undefined;
}

/** Whether a rated level is above `cap`; unrated / 'na' never exceed it. */
export function exceedsNsfwLevel(nsfwLevel: NsfwLevel | null | undefined, cap: NsfwLevel) {
  if (!nsfwLevel) return false;
  const rank = nsfwLevelSeverity.indexOf(nsfwLevel);
  const capRank = nsfwLevelSeverity.indexOf(cap);
  return rank >= 0 && capRank >= 0 && rank > capRank;
}

export function isMature(nsfwLevel?: NsfwLevel) {
  return nsfwLevel && matureNsfwLevels.includes(nsfwLevel);
}

// The orchestrator writes 'na' only when the provider moderated the output itself, so no scan
// was needed. If it ever means "scan failed", this lets unscanned private output through.
export function isPrivateMature(nsfwLevel?: NsfwLevel) {
  return nsfwLevel && nsfwLevel !== NsfwLevel.NA && !privateGenNsfwLevels.includes(nsfwLevel);
}
