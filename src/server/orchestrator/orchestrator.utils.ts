import type { WorkflowCallback } from '@civitai/client';
import { env } from '~/env/server';
import { SignalMessages, SignalTopic } from '~/server/common/enums';
import { withSignals } from '~/server/signals/wrapper';

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

/** `step:*` because the orchestrator's callback-type enum has no `step:preparing` — the wildcard is
 *  the only way to receive a download's progress. */
export function getResourceLoadCallbacks(
  modelVersionId: number
): Array<WorkflowCallback> | undefined {
  if (!env.SIGNALS_ENDPOINT) return;
  return [
    {
      url: `${env.SIGNALS_ENDPOINT}/groups/${SignalTopic.ModelVersion}:${modelVersionId}/signals/${SignalMessages.ResourceLoadUpdate}`,
      type: ['step:*'],
    },
  ];
}

/** POSTs to the signals group endpoint — everyone subscribed to the topic receives it, not one user. */
export async function sendSignalToTopic(topic: string, message: SignalMessages, data: unknown) {
  if (!env.SIGNALS_ENDPOINT) return;
  await withSignals(() =>
    fetch(`${env.SIGNALS_ENDPOINT}/groups/${topic}/signals/${message}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  );
}
