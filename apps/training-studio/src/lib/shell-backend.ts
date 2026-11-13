import type { TrainingQuote } from './orchestrator-core';
// The SvelteKit shell's StudioBackend: every call is a relative fetch to this app's own /api routes
// (the session-gated wrappers under src/routes/api/*). Flow code goes through $lib/host's backend()
// seam and never fetches '/api/…' itself; the only other client modules that do are signals.ts
// (the shell-only signals token) and trace.ts (its dev-only trace proxy).
import type {
  AutoLabelResult,
  EditGenerationItem,
  EditImageOption,
  StudioBackend,
  SubmittedBatch,
  TrainingRunPayload,
} from '$lib/backend';
import type {
  DatasetItem,
  GenerationItem,
  TrainingDetail,
  TrainingRow,
} from '$lib/data/trainingRows';
import type { EpochArchive } from '$lib/orchestrator-core';
import { parseServiceStatus } from '$lib/service-status-core';
import type { DatasetRatingCount } from '$lib/dataset-rating';
import type { ReadinessCheck, ReadinessProbe } from '$lib/upload-readiness';
import { FILES_PROCESSING_CODE, FilesProcessingError } from '$lib/files-processing';
import { MatureAckRequiredError } from '$lib/mature-charge';
import { UploadError, uploadProblem } from '$lib/upload';
import { AUTO_LABEL_UNAVAILABLE_CODE, AutoLabelRefusedError } from '$lib/autolabel-errors';

/** Pull `message` out of a SvelteKit error body, falling back to a status-tagged default. */
async function messageOf(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) return body.message;
  } catch {
    // non-JSON body
  }
  return fallback;
}

/** Why an auto-label submit failed. Our route answers 4xx only for a refusal made before any workflow
 *  existed (its own, or the main app's gates, validation and limits), and its marked 503 when
 *  auto-label is unavailable: those return the image's cap slot. Every other failure (a 502, a gateway
 *  503) may have come after a workflow was created and stays counted. */
async function autoLabelSubmitFailure(res: Response): Promise<Error> {
  const fallback = `auto-label submit failed (${res.status})`;
  const body = (await res.json().catch(() => null)) as { message?: string; code?: string } | null;
  const refused =
    (res.status >= 400 && res.status < 500) ||
    (res.status === 503 && body?.code === AUTO_LABEL_UNAVAILABLE_CODE);
  return refused ? new AutoLabelRefusedError(body?.message || fallback) : new Error(fallback);
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

/** GET `path` as JSON; a failure throws the route's message, else `fallback (status)`. */
async function getFor<T>(path: string, fallback: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal });
  if (!res.ok) throw new Error(await messageOf(res, `${fallback} (${res.status})`));
  return (await res.json()) as T;
}

async function quoteFrom(path: string): Promise<number | null> {
  const res = await fetch(path);
  if (!res.ok) return null;
  return ((await res.json()) as { cost: number | null }).cost;
}

async function postFor(path: string, body: unknown, fallback: string) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await messageOf(res, fallback));
  return (await res.json()) as { workflowId: string };
}

const READINESS_REQUEST_TIMEOUT_MS = 60_000;

async function postReadiness<T>(body: unknown): Promise<T> {
  const res = await fetch('/api/dataset-readiness', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    // A hung request would hold Start with no way out; failing releases it.
    signal: AbortSignal.timeout(READINESS_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Dataset readiness failed (${res.status})`);
  return (await res.json()) as T;
}

export const shellBackend: StudioBackend = {
  listTrainings: () => getFor<TrainingRow[]>('/api/trainings', 'Failed to load trainings'),

  // The /[id] page's own detail still comes from its server load (refresh() re-runs it); this seam
  // read serves RunDetail's ancestor-chain fetches (combined epochs).
  getRunDetail: (workflowId) =>
    getFor<TrainingDetail>(
      `/api/run-detail?id=${encodeURIComponent(workflowId)}`,
      'Failed to load training'
    ),

  modelLive: async (modelId) => {
    const res = await fetch(`/api/model-status?id=${modelId}`);
    if (!res.ok) throw new Error(await messageOf(res, `Model check failed (${res.status})`));
    return ((await res.json()) as { live: boolean }).live;
  },

  getRunDataset: async (workflowId) => {
    const res = await fetch(`/api/run-dataset?id=${encodeURIComponent(workflowId)}`);
    if (!res.ok) throw new Error("Couldn't load that dataset.");
    return (await res.json()) as DatasetItem[];
  },

  datasetBlob: async (air, workflowId) => {
    const res = await fetch(
      `/api/dataset-blob?air=${encodeURIComponent(air)}&workflowId=${encodeURIComponent(
        workflowId
      )}`
    );
    if (!res.ok) throw new Error(await messageOf(res, `Dataset image unavailable (${res.status})`));
    return res.blob();
  },

  listGenerations: async (media) => {
    const res = await fetch(`/api/generations?media=${media}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new Error(body?.message ?? `Failed to load generations (${res.status})`);
    }
    return ((await res.json()) as { items: GenerationItem[] }).items;
  },

  uploadUrl: async (signal) => {
    const res = await fetch('/api/upload-url', { method: 'POST', signal });
    if (!res.ok)
      throw new UploadError(
        res.status,
        uploadProblem(await res.text().catch(() => ''), res.status)
      );
    return (await res.json()) as { uploadUrl: string };
  },

  autoLabelSubmit: async (items, mode, media) => {
    const res = await fetch('/api/auto-label', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, media, items }),
    });
    if (!res.ok) throw await autoLabelSubmitFailure(res);
    return (await res.json()) as { workflowId: string };
  },

  autoLabelPoll: async (workflowId, signal) => {
    const res = await fetch(`/api/auto-label/${workflowId}`, { signal });
    if (!res.ok) throw new Error(`auto-label poll failed (${res.status})`);
    return (await res.json()) as { done: boolean; results: AutoLabelResult[] };
  },

  submitTraining: async (runs: TrainingRunPayload[]) => {
    const res = await fetch('/api/train', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runs }),
    });
    if (!res.ok) throw await startFailure(res, `Training could not start (${res.status})`);
    const { workflowIds, failure } = (await res.json()) as SubmittedBatch;
    return { workflowIds, failure };
  },

  datasetRating: async (blobIds) => {
    const res = await fetch('/api/dataset-rating', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blobIds }),
    });
    if (!res.ok) throw new Error(`Dataset rating failed (${res.status})`);
    return (await res.json()) as DatasetRatingCount;
  },

  datasetReadiness: (blobIds) => postReadiness<ReadinessProbe>({ blobIds }),
  datasetReadyToTrain: (run) => postReadiness<ReadinessCheck>({ run }),

  listEditGenerations: async () =>
    (
      await getFor<{ items: EditGenerationItem[] }>(
        '/api/generations?media=image&kind=edit',
        'Failed to load your edits'
      )
    ).items,

  editImageQuote: (imageUrl) =>
    quoteFrom(`/api/edit-image?imageUrl=${encodeURIComponent(imageUrl)}`),

  editImageSubmit: (req) => postFor('/api/edit-image', req, "Couldn't create the image."),

  editImagePoll: (workflowId, signal) =>
    getFor<{ done: boolean; options: EditImageOption[] }>(
      `/api/edit-image/${encodeURIComponent(workflowId)}`,
      'Image progress unavailable',
      signal
    ),

  suggestQuote: () => quoteFrom('/api/suggest-instruction'),

  suggestSubmit: (req) =>
    postFor('/api/suggest-instruction', req, "Couldn't suggest an instruction."),

  suggestPoll: (workflowId, signal) =>
    getFor<{ done: boolean; text?: string }>(
      `/api/suggest-instruction/${encodeURIComponent(workflowId)}`,
      'Suggestion unavailable',
      signal
    ),

  rename: async (workflowId, name) => {
    const res = await fetch('/api/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowId, name }),
    });
    if (!res.ok) throw new Error(await messageOf(res, `Could not rename (${res.status})`));
  },

  epochArchive: async (workflowId, kind) => {
    const res = await fetch(
      `/api/epoch-archive?id=${encodeURIComponent(workflowId)}&kind=${kind}`,
      { method: 'POST' }
    );
    if (!res.ok) throw new Error(await messageOf(res, "Couldn't build the archive."));
    return (await res.json()) as EpochArchive[];
  },

  deleteTraining: async (workflowId) => {
    const res = await fetch(`/api/trainings?id=${encodeURIComponent(workflowId)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(await messageOf(res, `Could not delete (${res.status})`));
  },

  continueQuote: async (workflowId, fromEpoch, addEpochs, currencies) => {
    const params = new URLSearchParams({
      id: workflowId,
      fromEpoch: String(fromEpoch),
      addEpochs: String(addEpochs),
    });
    for (const currency of currencies) params.append('currencies', currency);
    const res = await fetch(`/api/continue-training?${params}`);
    if (!res.ok) throw new Error(await messageOf(res, 'Could not price the continuation.'));
    return (await res.json()) as { cost: number | null; steps?: number; matureCount: number };
  },

  continueRun: async (workflowId, fromEpoch, addEpochs, currencies, matureAck) => {
    const res = await fetch('/api/continue-training', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowId, fromEpoch, addEpochs, currencies, matureAck }),
    });
    if (!res.ok) throw await startFailure(res, 'Could not start training.');
    return ((await res.json()) as { workflowId: string }).workflowId;
  },

  // The shell's flow gets prices streamed from the /new server load (redis-cached, shared across
  // users) — only the web-component host quotes browser-side.
  getFromPrices: () =>
    Promise.reject(new Error('from-prices come from the /new server load in the shell')),

  quoteRun: async (input) => {
    const res = await fetch('/api/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    return (await res.json()) as TrainingQuote;
  },

  getBuzz: async () => {
    const res = await fetch('/api/buzz');
    if (!res.ok) return null;
    return (await res.json()) as { yellow: number; green: number; blue: number } | null;
  },

  getServiceStatus: async () => {
    const res = await fetch('/api/training-status');
    if (!res.ok) return null;
    return parseServiceStatus(await res.json());
  },
};
