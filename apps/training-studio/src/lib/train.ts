import type { TrainingStudioMeta } from '$lib/data/trainingRows';

/** One dataset item on the wire: the uploaded blob's key/URL and its raw label (trigger applied server-side). */
export interface TrainingItem {
  air: string;
  caption: string;
}

/** One run's fully-resolved training config sent to POST /api/train. Mirrors the server's
 *  `TrainingRunInput` (the client/server wire contract; a client module can't import `$lib/server`). */
export interface TrainingRunPayload {
  ecosystem: string;
  modelVariant?: string;
  version?: string;
  engine?: string;
  model?: string;
  steps: number;
  epochs: number;
  unetLr: number;
  textEncoderLr: number;
  networkDim: number;
  networkAlpha: number;
  resolution: number;
  batchSize: number;
  lrScheduler: string;
  optimizer: string;
  trigger: string;
  items: TrainingItem[];
  prompts: string[];
  /** Buzz accounts to charge, in priority order — the user's Review-step choice (validated server-side). */
  currencies: string[];
  meta: TrainingStudioMeta;
}

/** Submit the real training workflow(s); returns their ids. Throws with a readable message on failure. */
export async function postTraining(runs: TrainingRunPayload[]): Promise<string[]> {
  const res = await fetch('/api/train', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runs }),
  });
  if (!res.ok) {
    let message = `Training could not start (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // non-JSON body
    }
    throw new Error(message);
  }
  const { workflowIds } = (await res.json()) as { workflowIds: string[] };
  return workflowIds;
}

/** Rename a training (updates its metadata title + name tag). Throws with a readable message on failure. */
export async function postRename(workflowId: string, name: string): Promise<void> {
  const res = await fetch('/api/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowId, name }),
  });
  if (!res.ok) {
    let message = `Could not rename (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // non-JSON body
    }
    throw new Error(message);
  }
}
