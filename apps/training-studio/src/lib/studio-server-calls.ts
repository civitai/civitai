// The calls that start or price a training run, and Review's mature count, answered by the Studio's
// own server routes (/api/train, /api/continue-training, /api/dataset-rating). The shell reaches them
// with a relative fetch; the web component reaches them through its host's `studioServer` hook.
import type { StudioBackend, SubmittedBatch, TrainingRunPayload } from '$lib/backend';
import type { DatasetRatingCount } from '$lib/dataset-rating';
import { FILES_PROCESSING_CODE, FilesProcessingError } from '$lib/files-processing';
import { MatureAckRequiredError } from '$lib/mature-charge';

/** A request to one of the Studio's /api routes: `path` is the route's path and query. */
export type StudioServerFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Pull `message` out of a SvelteKit error body, falling back to a status-tagged default. */
export async function messageOf(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) return body.message;
  } catch {
    // non-JSON body
  }
  return fallback;
}

/** A refused training submit; a 409 carrying the server's mature count becomes `MatureAckRequiredError`,
 *  so the caller can show the confirm. */
async function startFailure(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as {
    message?: string;
    matureCount?: unknown;
    code?: unknown;
  } | null;
  if (body?.code === FILES_PROCESSING_CODE) return new FilesProcessingError();
  if (res.status === 409 && typeof body?.matureCount === 'number' && body.matureCount > 0)
    return new MatureAckRequiredError(body.matureCount);
  return new Error(body?.message || fallback);
}

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export function studioServerCalls(
  server: StudioServerFetch
): Pick<StudioBackend, 'submitTraining' | 'datasetRating' | 'continueQuote' | 'continueRun'> {
  return {
    submitTraining: async (runs: TrainingRunPayload[]) => {
      const res = await server('/api/train', postJson({ runs }));
      if (!res.ok) throw await startFailure(res, `Training could not start (${res.status})`);
      const { workflowIds, failure } = (await res.json()) as SubmittedBatch;
      return { workflowIds, failure };
    },

    datasetRating: async (blobIds) => {
      const res = await server('/api/dataset-rating', postJson({ blobIds }));
      if (!res.ok) throw new Error(`Dataset rating failed (${res.status})`);
      return (await res.json()) as DatasetRatingCount;
    },

    continueQuote: async (workflowId, fromEpoch, addEpochs, currencies) => {
      const params = new URLSearchParams({
        id: workflowId,
        fromEpoch: String(fromEpoch),
        addEpochs: String(addEpochs),
      });
      for (const currency of currencies) params.append('currencies', currency);
      const res = await server(`/api/continue-training?${params}`);
      if (!res.ok) throw new Error(await messageOf(res, 'Could not price the continuation.'));
      return (await res.json()) as { cost: number | null; steps?: number; matureCount: number };
    },

    continueRun: async (workflowId, fromEpoch, addEpochs, currencies, matureAck) => {
      const res = await server(
        '/api/continue-training',
        postJson({ workflowId, fromEpoch, addEpochs, currencies, matureAck })
      );
      if (!res.ok) throw await startFailure(res, 'Could not start training.');
      return ((await res.json()) as { workflowId: string }).workflowId;
    },
  };
}
