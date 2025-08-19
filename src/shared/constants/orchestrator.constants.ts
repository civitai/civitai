import { WorkflowStatus } from '@civitai/client';

export const POLLABLE_STATUSES: WorkflowStatus[] = [
  WorkflowStatus.UNASSIGNED,
  WorkflowStatus.PREPARING,
  WorkflowStatus.SCHEDULED,
  WorkflowStatus.PROCESSING,
];

export const COMPLETE_STATUSES: WorkflowStatus[] = [
  WorkflowStatus.SUCCEEDED,
  WorkflowStatus.FAILED,
  WorkflowStatus.EXPIRED,
  WorkflowStatus.CANCELED,
];
