import { WorkflowStatus } from '@civitai/client';

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
