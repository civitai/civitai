import type { InfiniteData } from '@tanstack/react-query';

// #region [interfaces]
export interface IWorkflowStep {
  name: string;
  metadata?: Record<string, unknown>;
}

export interface IWorkflow {
  id: string;
  steps: IWorkflowStep[];
  tags: string[];
}

export type IWorkflowsInfinite = InfiniteData<{ items: IWorkflow[] }>;
// #endregion
