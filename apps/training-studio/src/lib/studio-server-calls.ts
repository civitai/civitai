// The calls that spend (start a training run, generate an edit or a suggestion, build an epoch
// archive), plus pricing a continuation and Review's mature count, answered by the Studio's own server
// routes. The shell reaches them with a relative fetch; the web component reaches them through its
// host's `studioServer` hook.
import type { StudioBackend, SubmittedBatch, TrainingRunPayload } from '$lib/backend';
import type { DatasetRatingCount } from '$lib/dataset-rating';
import type { EpochArchive } from '$lib/orchestrator-core';
import { FILES_PROCESSING_CODE, FilesProcessingError } from '$lib/files-processing';
import { MatureRepriceError } from '$lib/mature-charge';

/** A request to one of the Studio's /api routes: `path` is the route's path and query. */
export type StudioServerFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Pull the reason out of an error body (a SvelteKit `message`, or a host route's `error`), falling
 *  back to a status-tagged default. A 401's `error` is a code (the session prompt), not a reason. */
export async function messageOf(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    if (body.message) return body.message;
    if (res.status !== 401 && typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // non-JSON body
  }
  return fallback;
}

/** A refused training submit; a 409 carrying the server's mature count becomes `MatureRepriceError`,
 *  so the caller can show the repriced spend. */
async function startFailure(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as {
    message?: string;
    error?: unknown;
    matureCount?: unknown;
    code?: unknown;
  } | null;
  if (body?.code === FILES_PROCESSING_CODE) return new FilesProcessingError();
  if (res.status === 409 && typeof body?.matureCount === 'number' && body.matureCount > 0)
    return new MatureRepriceError(body.matureCount);
  const reason = res.status !== 401 && typeof body?.error === 'string' ? body.error : undefined;
  return new Error(body?.message || reason || fallback);
}

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export function studioServerCalls(
  server: StudioServerFetch
): Pick<
  StudioBackend,
  | 'submitTraining'
  | 'datasetRating'
  | 'pendingLicenses'
  | 'acceptLicense'
  | 'continueQuote'
  | 'continueRun'
  | 'editImageSubmit'
  | 'suggestSubmit'
  | 'epochArchive'
> {
  const submitHelper = async (path: string, body: unknown, fallback: string) => {
    const res = await server(path, postJson(body));
    if (!res.ok) throw new Error(await messageOf(res, fallback));
    return { workflowId: ((await res.json()) as { workflowId: string }).workflowId };
  };

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

    pendingLicenses: async () => {
      const res = await server('/api/license');
      if (!res.ok) throw new Error(await messageOf(res, 'Could not check the model licence.'));
      return ((await res.json()) as { pending: string[] }).pending;
    },

    acceptLicense: async (ecosystem) => {
      const res = await server('/api/license', postJson({ ecosystem }));
      if (!res.ok) throw new Error(await messageOf(res, 'Could not accept the licence.'));
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

    continueRun: async (workflowId, fromEpoch, addEpochs, currencies, matureCount) => {
      const res = await server(
        '/api/continue-training',
        postJson({ workflowId, fromEpoch, addEpochs, currencies, matureCount })
      );
      if (!res.ok) throw await startFailure(res, 'Could not start training.');
      return ((await res.json()) as { workflowId: string }).workflowId;
    },

    editImageSubmit: (req) => submitHelper('/api/edit-image', req, "Couldn't create the image."),

    suggestSubmit: (req) =>
      submitHelper('/api/suggest-instruction', req, "Couldn't suggest an instruction."),

    epochArchive: async (workflowId, kind) => {
      const params = new URLSearchParams({ id: workflowId, kind });
      // An empty JSON body: the embed's forward takes only JSON posts.
      const res = await server(`/api/epoch-archive?${params}`, postJson({}));
      if (!res.ok) throw new Error(await messageOf(res, "Couldn't build the archive."));
      return (await res.json()) as EpochArchive[];
    },
  };
}
