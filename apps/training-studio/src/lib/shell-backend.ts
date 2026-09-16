// The SvelteKit shell's StudioBackend: every call is a relative fetch to this app's own /api routes
// (the session-gated wrappers under src/routes/api/*). Flow code goes through $lib/host's backend()
// seam and never fetches '/api/…' itself; the only other client modules that do are signals.ts
// (the shell-only signals token) and trace.ts (its dev-only trace proxy).
import type { AutoLabelResult, StudioBackend, TrainingRunPayload } from '$lib/backend';
import type { GenerationItem, TrainingDetail, TrainingRow } from '$lib/data/trainingRows';
import { UploadError, uploadProblem } from '$lib/upload';

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

export const shellBackend: StudioBackend = {
  listTrainings: async () => {
    const res = await fetch('/api/trainings');
    if (!res.ok) throw new Error(await messageOf(res, `Failed to load trainings (${res.status})`));
    return (await res.json()) as TrainingRow[];
  },

  // The /[id] page's own detail still comes from its server load (refresh() re-runs it); this seam
  // read serves RunDetail's ancestor-chain fetches (combined epochs).
  getRunDetail: async (workflowId) => {
    const res = await fetch(`/api/run-detail?id=${encodeURIComponent(workflowId)}`);
    if (!res.ok) throw new Error(await messageOf(res, `Failed to load training (${res.status})`));
    return (await res.json()) as TrainingDetail;
  },

  getRunDataset: async (workflowId) => {
    const res = await fetch(`/api/run-dataset?id=${encodeURIComponent(workflowId)}`);
    if (!res.ok) throw new Error("Couldn't load that dataset.");
    return (await res.json()) as { air: string; caption: string }[];
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
    if (!res.ok) throw new Error(`auto-label submit failed (${res.status})`);
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
    if (!res.ok) throw new Error(await messageOf(res, `Training could not start (${res.status})`));
    const { workflowIds } = (await res.json()) as { workflowIds: string[] };
    return workflowIds;
  },

  rename: async (workflowId, name) => {
    const res = await fetch('/api/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowId, name }),
    });
    if (!res.ok) throw new Error(await messageOf(res, `Could not rename (${res.status})`));
  },

  continueQuote: async (workflowId, fromEpoch, addEpochs) => {
    const res = await fetch(
      `/api/continue-training?id=${encodeURIComponent(
        workflowId
      )}&fromEpoch=${fromEpoch}&addEpochs=${addEpochs}`
    );
    if (!res.ok) throw new Error(await res.text().catch(() => 'Could not price the continuation.'));
    return (await res.json()) as { cost: number | null; steps?: number };
  },

  continueRun: async (workflowId, fromEpoch, addEpochs, currencies) => {
    const res = await fetch('/api/continue-training', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowId, fromEpoch, addEpochs, currencies }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(detail || 'Could not start training.');
    }
    return ((await res.json()) as { workflowId: string }).workflowId;
  },

  // The shell's flow gets prices streamed from the /new server load (redis-cached, shared across
  // users) — only the web-component host quotes browser-side.
  getFromPrices: () =>
    Promise.reject(new Error('from-prices come from the /new server load in the shell')),

  getBuzz: async () => {
    const res = await fetch('/api/buzz');
    if (!res.ok) return null;
    return (await res.json()) as { yellow: number; green: number; blue: number } | null;
  },
};
