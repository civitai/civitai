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
const privateGenNsfwLevels: NsfwLevel[] = [NsfwLevel.PG];

export function isMature(nsfwLevel?: NsfwLevel) {
  return nsfwLevel && matureNsfwLevels.includes(nsfwLevel);
}

export function isPrivateMature(nsfwLevel?: NsfwLevel) {
  return nsfwLevel && !privateGenNsfwLevels.includes(nsfwLevel);
}
