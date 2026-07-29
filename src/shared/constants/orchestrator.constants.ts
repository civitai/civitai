import { NsfwLevel, WorkflowStatus } from '@civitai/client';

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

export function isMature(nsfwLevel?: NsfwLevel) {
  return nsfwLevel && matureNsfwLevels.includes(nsfwLevel);
}

export function isPrivateMature(nsfwLevel?: NsfwLevel) {
  return nsfwLevel && !privateGenNsfwLevels.includes(nsfwLevel);
}
