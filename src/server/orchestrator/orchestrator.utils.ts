import type { WorkflowCallback } from '@civitai/client';
import { env } from '~/env/server';
import { SignalMessages } from '~/server/common/enums';

export function getOrchestratorCallbacks(userId: number): Array<WorkflowCallback> | undefined {
  if (!env.SIGNALS_ENDPOINT) return;
  return [
    {
      url: `${env.SIGNALS_ENDPOINT}/users/${userId}/signals/${SignalMessages.TextToImageUpdate}`,
      type: ['step:*'],
      // type: ['workflow:*', 'step:*'],
      // type: ['workflow:*', 'step:*', 'job:*'],
    },
  ];
}

/** Generic workflow callbacks — used for non-generation workflows (prompt enhancement, etc.) */
export function getWorkflowCallbacks(userId: number): Array<WorkflowCallback> | undefined {
  if (!env.SIGNALS_ENDPOINT) return;
  return [
    {
      url: `${env.SIGNALS_ENDPOINT}/users/${userId}/signals/${SignalMessages.WorkflowUpdate}`,
      type: ['step:*'],
    },
  ];
}
