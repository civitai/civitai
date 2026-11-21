import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError, json } from '@sveltejs/kit';

// The embed's training submits run through the Studio's own server routes, which count the dataset's
// mature images under the v2 rating. Here the host's `studioServer` hook is wired straight to those
// route handlers, and the orchestrator is faked below both halves: a run the browser would build and
// submit itself is caught by `submitWorkflow` being called.

const orch = vi.hoisted(() => ({
  submitWorkflow: vi.fn(),
  headBlob: vi.fn(),
  getWorkflow: vi.fn(),
}));
// Hand-listed: the real client's dist cannot load under Node's ESM loader (see train-core.test.ts).
vi.mock('@civitai/orchestration-client', () => ({
  Air: { isAir: () => false, parseSafe: () => undefined },
  createCivitaiClient: () => ({ interceptors: { response: { use: () => undefined } } }),
  getResource: vi.fn(),
  getWorkflow: (...args: unknown[]) => orch.getWorkflow(...args),
  updateWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  submitWorkflow: (...args: unknown[]) => orch.submitWorkflow(...args),
  headBlob: (...args: unknown[]) => orch.headBlob(...args),
  invokeImageScanningStepTemplate: vi.fn(),
}));

const rating = vi.hoisted(() => ({ stored: {} as Record<string, { mature: boolean }> }));
vi.mock('$lib/server/dataset-rating', () => ({
  datasetRatingFor: async () => ({
    matureLevel: 3,
    read: async (keys: string[]) =>
      new Map(keys.flatMap((k) => (rating.stored[k] ? [[k, rating.stored[k]]] : []))),
  }),
  warmDatasetRating: () => undefined,
  claimDaily: async () => 1,
}));
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
vi.mock('$lib/server/text-check', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/text-check')>()),
  requestTextCheck: () => async () => undefined,
}));
vi.mock('$lib/server/service-status', () => ({ getTrainingServiceStatus: async () => null }));
vi.mock('$lib/server/flipt', () => ({ isKohyaAllowed: async () => false }));
vi.mock('$lib/server/signals', () => ({ workflowSignalCallbacks: () => undefined }));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: () => undefined, safeError: (e: unknown) => e }));

import { elementBackend, type StudioElementHost } from './backend';
import { MatureRepriceError } from '$lib/mature-charge';
import type { TrainingRunPayload } from '$lib/backend';
import { POST as trainPost } from '../../routes/api/train/+server';

type Handler = (event: never) => Response | Promise<Response>;
const studioRoutes: Record<string, Handler> = { '/api/train': trainPost as Handler };

/** The Studio server as the host's hook reaches it: the route's answer, or its HttpError as JSON. */
async function studioServer(path: string, init?: RequestInit): Promise<Response> {
  const route = studioRoutes[path.split('?')[0]!];
  if (!route) return new Response(null, { status: 404 });
  const request = new Request(`https://studio.example${path}`, init);
  try {
    return await route({ locals: { user: { id: 7 }, devPreview: false }, request } as never);
  } catch (err) {
    if (isHttpError(err)) return json(err.body, { status: err.status });
    throw err;
  }
}

const host = {
  getOrchestratorToken: async () => 'token',
  checkTrainingText: async () => ({ ok: true } as const),
  config: { orchestratorEndpoint: 'https://orchestrator.example' },
  hrefFor: () => '/',
  navigate: async () => undefined,
  studioServer,
} as StudioElementHost;

const air = (id: string) => `urn:air:other:blob:civitai:blob@${id}`;
const greenRun = (blobId: string): TrainingRunPayload =>
  ({
    ecosystem: 'sdxl',
    steps: 2000,
    epochs: 10,
    unetLr: 5e-4,
    textEncoderLr: 5e-5,
    networkDim: 32,
    networkAlpha: 32,
    resolution: 1024,
    batchSize: 4,
    lrScheduler: 'cosine',
    optimizer: 'Adafactor',
    trigger: 'ohwx',
    items: [{ air: air(blobId), caption: 'ohwx' }],
    prompts: ['ohwx, a photo'],
    meta: { name: 'test' },
    currencies: ['green'],
  } as TrainingRunPayload);

describe('embed training submit, mature count', () => {
  beforeEach(() => {
    orch.submitWorkflow.mockReset().mockResolvedValue({ data: { id: 'wf-1' } });
    // Every image's upload rating says PG: only the v2 rating knows what it shows.
    orch.headBlob.mockReset().mockImplementation(async () => ({
      response: new Response(null, { status: 204, headers: { 'X-NSFW-Level': 'PG' } }),
    }));
  });

  it('refuses a Green run priced as not mature whose dataset the v2 rating calls mature, before anything is submitted', async () => {
    rating.stored = { 'nude-1': { mature: true } };
    await expect(elementBackend(host).submitTraining([greenRun('nude-1')])).rejects.toBeInstanceOf(
      MatureRepriceError
    );
    expect(orch.submitWorkflow).not.toHaveBeenCalled();
  });

  it('submits a Green run whose dataset the v2 rating calls safe', async () => {
    rating.stored = { 'portrait-1': { mature: false } };
    await expect(
      elementBackend(host).submitTraining([greenRun('portrait-1')])
    ).resolves.toMatchObject({ workflowIds: ['wf-1'] });
    expect(orch.submitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('submits nothing on a host page without the Studio server', async () => {
    rating.stored = {};
    const { studioServer: _omit, ...bare } = host;
    await expect(elementBackend(bare).submitTraining([greenRun('portrait-1')])).rejects.toThrow(
      'Training is unavailable on this page right now. Reload and try again.'
    );
    expect(orch.submitWorkflow).not.toHaveBeenCalled();
  });
});
