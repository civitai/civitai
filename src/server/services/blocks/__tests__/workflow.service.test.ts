import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * Pure-helper coverage for the block workflow service. Snapshot mapping and
 * input building have no I/O, so we test them directly. resolveBlockVersion
 * goes through Prisma — mocked at the module boundary so the test stays
 * in-process and deterministic.
 */

const { mockDbRead } = vi.hoisted(() => ({
  mockDbRead: {
    modelVersion: { findUnique: vi.fn() },
  },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead }));

import {
  buildImageWorkflowInput,
  buildTextToImageInput,
  BLOCK_IMAGE_WORKFLOW_TYPES,
  isPageLoraResource,
  resolveBlockImageWorkflowType,
  resolveBlockVersionContext,
  resolvePageResourceContext,
  snapshotFromWorkflow,
} from '../workflow.service';
import { blockWorkflowBodySchema } from '~/server/schema/blocks/workflow.schema';
// REAL param-building path (no mocks): the generation graph validator and the
// step-metadata snapshot fn are the exact functions the orchestrator's
// `createWorkflowStepsFromGraph` runs to derive `workflowMetadata.params`. Both
// live in the browser-safe `shared/` tree (no DB/redis), so we import and run
// them for real in the integration-style test below.
import { generationGraph } from '~/shared/data-graph/generation/generation-graph';
import { ECO } from '~/shared/constants/basemodel.constants';
import { toStepMetadata } from '~/shared/utils/resource.utils';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

function fakeWorkflow(over: Record<string, unknown> = {}) {
  return {
    id: 'wf_123',
    createdAt: '2026-05-24T00:00:00Z',
    status: 'succeeded' as const,
    metadata: {},
    tags: [],
    arguments: {},
    steps: [],
    callbacks: [],
    tips: { civitai: 0, creators: 0 },
    cost: { total: 42 },
    currencies: [],
    upgradeMode: 'manual' as const,
    forceRefunded: false,
    ...over,
  };
}

describe('snapshotFromWorkflow', () => {
  it('maps the happy path with image URLs', () => {
    const wf = fakeWorkflow({
      steps: [
        {
          $type: 'textToImage',
          name: 's1',
          status: 'succeeded',
          metadata: {},
          output: {
            images: [
              { id: 'b1', url: 'https://cdn/img1.png', available: true, type: 'image' },
              { id: 'b2', url: 'https://cdn/img2.png', available: true, type: 'image' },
            ],
          },
        },
      ],
    });
    const snap = snapshotFromWorkflow(wf as never);
    expect(snap.workflowId).toBe('wf_123');
    expect(snap.status).toBe('succeeded');
    expect(snap.cost).toEqual({ total: 42 });
    expect(snap.imageUrls).toEqual(['https://cdn/img1.png', 'https://cdn/img2.png']);
  });

  it('drops blobs that are pending or have no url (no broken-image links)', () => {
    const wf = fakeWorkflow({
      steps: [
        {
          $type: 'textToImage',
          name: 's1',
          status: 'processing',
          metadata: {},
          output: {
            images: [
              { id: 'b1', url: 'https://cdn/ok.png', available: true, type: 'image' },
              { id: 'b2', url: null, available: false, type: 'image' },
              { id: 'b3', url: 'https://cdn/blocked.png', available: false, type: 'image' },
              { id: 'b4', url: '', available: true, type: 'image' },
            ],
          },
        },
      ],
    });
    const snap = snapshotFromWorkflow(wf as never);
    expect(snap.imageUrls).toEqual(['https://cdn/ok.png']);
  });

  it('emits a non-empty sentinel workflowId for whatif/estimate (no orchestrator id)', () => {
    // The block SDK validator drops snapshots with an empty workflowId, which
    // strands ESTIMATE_RESULT until the 120s timeout (gotcha #55). A whatif
    // workflow has no id, so the snapshot must carry a non-empty sentinel.
    const snap = snapshotFromWorkflow(fakeWorkflow({ id: undefined }) as never);
    expect(snap.workflowId).toBe('whatif');
    expect(snap.workflowId.length).toBeGreaterThan(0);
  });

  it('maps orchestrator-internal statuses (unassigned/preparing/scheduled) to pending', () => {
    for (const status of ['unassigned', 'preparing', 'scheduled'] as const) {
      const snap = snapshotFromWorkflow(fakeWorkflow({ status }) as never);
      expect(snap.status).toBe('pending');
    }
  });

  it('omits cost when orchestrator returns no total', () => {
    const snap = snapshotFromWorkflow(fakeWorkflow({ cost: {} }) as never);
    expect(snap.cost).toBeUndefined();
  });

  it('omits imageUrls when there are no available images', () => {
    const snap = snapshotFromWorkflow(fakeWorkflow({ steps: [] }) as never);
    expect(snap.imageUrls).toBeUndefined();
  });

  it('ignores steps with non-image-producing types (e.g. chatCompletion)', () => {
    const wf = fakeWorkflow({
      steps: [
        {
          $type: 'chatCompletion',
          name: 's1',
          status: 'succeeded',
          metadata: {},
          output: { images: [{ id: 'x', url: 'https://leak/', available: true }] },
        },
      ],
    });
    const snap = snapshotFromWorkflow(wf as never);
    expect(snap.imageUrls).toBeUndefined();
  });

  // ---- image extraction across ALL image-producing step types --------------
  // The extractor accepts THREE step types (textToImage / imageGen / comfy);
  // the happy-path test above only exercises textToImage. These pin the other
  // two branches + the cross-step concatenation order.
  it('surfaces images from an imageGen step', () => {
    const wf = fakeWorkflow({
      steps: [
        {
          $type: 'imageGen',
          name: 's1',
          status: 'succeeded',
          metadata: {},
          output: { images: [{ id: 'g1', url: 'https://cdn/gen.png', available: true }] },
        },
      ],
    });
    const snap = snapshotFromWorkflow(wf as never);
    expect(snap.imageUrls).toEqual(['https://cdn/gen.png']);
  });

  it('surfaces images from a comfy step', () => {
    const wf = fakeWorkflow({
      steps: [
        {
          $type: 'comfy',
          name: 's1',
          status: 'succeeded',
          metadata: {},
          output: { images: [{ id: 'c1', url: 'https://cdn/comfy.png', available: true }] },
        },
      ],
    });
    const snap = snapshotFromWorkflow(wf as never);
    expect(snap.imageUrls).toEqual(['https://cdn/comfy.png']);
  });

  it('concatenates available images across mixed image-producing steps in step order', () => {
    const wf = fakeWorkflow({
      steps: [
        {
          $type: 'textToImage',
          name: 's1',
          status: 'succeeded',
          metadata: {},
          output: { images: [{ id: 'a', url: 'https://cdn/a.png', available: true }] },
        },
        {
          // A non-image step interleaved — must be skipped, not break ordering.
          $type: 'chatCompletion',
          name: 's2',
          status: 'succeeded',
          metadata: {},
          output: { images: [{ id: 'leak', url: 'https://leak/', available: true }] },
        },
        {
          $type: 'comfy',
          name: 's3',
          status: 'succeeded',
          metadata: {},
          output: { images: [{ id: 'b', url: 'https://cdn/b.png', available: true }] },
        },
      ],
    });
    const snap = snapshotFromWorkflow(wf as never);
    expect(snap.imageUrls).toEqual(['https://cdn/a.png', 'https://cdn/b.png']);
  });

  it('tolerates an image-producing step that carries no output (undefined images)', () => {
    const wf = fakeWorkflow({
      steps: [{ $type: 'textToImage', name: 's1', status: 'processing', metadata: {} }],
    });
    const snap = snapshotFromWorkflow(wf as never);
    expect(snap.imageUrls).toBeUndefined();
  });

  // ---- spentAccountType (money page blocks) --------------------------------
  // The snapshot surfaces the account that PRIMARILY funded the generation:
  // the accountType of the LARGEST realized debit on transactions.list.
  describe('spentAccountType (realized spent account)', () => {
    it('omits spentAccountType when there are no transactions (backward compatible)', () => {
      const snap = snapshotFromWorkflow(fakeWorkflow() as never);
      expect(snap.spentAccountType).toBeUndefined();
    });

    it('omits spentAccountType when the transactions list is empty', () => {
      const snap = snapshotFromWorkflow(
        fakeWorkflow({ transactions: { list: [] } }) as never
      );
      expect(snap.spentAccountType).toBeUndefined();
    });

    it('surfaces the accountType of the largest debit (split blue+green → green when green is larger)', () => {
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          transactions: {
            list: [
              { type: 'debit', amount: 10, accountType: 'blue' },
              { type: 'debit', amount: 90, accountType: 'green' },
            ],
          },
        }) as never
      );
      expect(snap.spentAccountType).toBe('green');
    });

    it('reports blue when blue is the largest debit (free-funded generation)', () => {
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          transactions: {
            list: [
              { type: 'debit', amount: 80, accountType: 'blue' },
              { type: 'debit', amount: 5, accountType: 'yellow' },
            ],
          },
        }) as never
      );
      expect(snap.spentAccountType).toBe('blue');
    });

    it('ignores credits when picking the largest debit', () => {
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          transactions: {
            list: [
              { type: 'debit', amount: 20, accountType: 'yellow' },
              // A larger CREDIT (refund/correction) must not be treated as a spend.
              { type: 'credit', amount: 100, accountType: 'green' },
            ],
          },
        }) as never
      );
      expect(snap.spentAccountType).toBe('yellow');
    });

    it('omits spentAccountType when the largest debit is an internal-only account (fakeRed)', () => {
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          transactions: { list: [{ type: 'debit', amount: 50, accountType: 'fakeRed' }] },
        }) as never
      );
      expect(snap.spentAccountType).toBeUndefined();
    });

    it('compares debits by MAGNITUDE, so negatively-signed debit amounts still rank (Math.abs)', () => {
      // The orchestrator may represent a debit as a negative amount. The picker
      // ranks by absolute value, so a -90 green debit must outrank a -10 blue one
      // (existing tests only use positive amounts — this pins the sign-agnostic
      // branch).
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          transactions: {
            list: [
              { type: 'debit', amount: -10, accountType: 'blue' },
              { type: 'debit', amount: -90, accountType: 'green' },
            ],
          },
        }) as never
      );
      expect(snap.spentAccountType).toBe('green');
    });

    it('breaks an equal-magnitude tie deterministically toward the FIRST debit (reduce keeps the accumulator)', () => {
      // Two debits of equal magnitude: the reduce keeps `a` on a non-strict-greater
      // `b`, so the FIRST-listed debit wins. Pinning this guards against a flip to
      // `>=` that would silently change which account gets reported.
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          transactions: {
            list: [
              { type: 'debit', amount: 50, accountType: 'green' },
              { type: 'debit', amount: 50, accountType: 'yellow' },
            ],
          },
        }) as never
      );
      expect(snap.spentAccountType).toBe('green');
    });

    it('treats a debit with no amount as 0, so a real debit outranks it', () => {
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          transactions: {
            list: [
              { type: 'debit', accountType: 'blue' }, // amount omitted → 0
              { type: 'debit', amount: 5, accountType: 'green' },
            ],
          },
        }) as never
      );
      expect(snap.spentAccountType).toBe('green');
    });

    it('omits spentAccountType when the ONLY entries are credits (no debit to attribute)', () => {
      const snap = snapshotFromWorkflow(
        fakeWorkflow({
          transactions: {
            list: [
              { type: 'credit', amount: 30, accountType: 'green' },
              { type: 'credit', amount: 5, accountType: 'yellow' },
            ],
          },
        }) as never
      );
      expect(snap.spentAccountType).toBeUndefined();
    });
  });
});

describe('resolveBlockVersionContext', () => {
  beforeEach(() => {
    mockDbRead.modelVersion.findUnique.mockReset();
  });

  it('returns resolved fields when the version is published and belongs to the bound model', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 99,
      baseModel: 'SDXL 1.0',
      modelId: 7,
      status: 'Published',
      model: { id: 7, type: 'Checkpoint' },
    });
    const out = await resolveBlockVersionContext(99, 7);
    expect(out).toEqual({
      modelId: 7,
      modelVersionId: 99,
      baseModel: 'SDXL 1.0',
      modelType: 'Checkpoint',
      // `gate` is the additive entitlement context the resolver now returns
      // (early-access / availability / coverage / members-only). This mock only
      // stubs id/baseModel/status/model, so the optional gate fields resolve to
      // undefined and coverage defaults to false.
      gate: {
        id: 99,
        status: 'Published',
        availability: undefined,
        usageControl: undefined,
        baseModel: 'SDXL 1.0',
        covered: false,
        modelUserId: undefined,
        modelType: 'Checkpoint',
        modelVersionAlias: null,
      },
    });
  });

  it('throws NOT_FOUND when the version is missing', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue(null);
    await expect(resolveBlockVersionContext(99, 7)).rejects.toBeInstanceOf(TRPCError);
    await expect(resolveBlockVersionContext(99, 7)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws NOT_FOUND when the version is unpublished (no information leak about other models)', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 99,
      baseModel: 'SDXL 1.0',
      modelId: 7,
      status: 'Draft',
      model: { id: 7, type: 'Checkpoint' },
    });
    await expect(resolveBlockVersionContext(99, 7)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws FORBIDDEN when the version belongs to a different model than the bound one', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 99,
      baseModel: 'SDXL 1.0',
      modelId: 8,
      status: 'Published',
      model: { id: 8, type: 'Checkpoint' },
    });
    await expect(resolveBlockVersionContext(99, 7)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('buildTextToImageInput', () => {
  const baseBody = {
    kind: 'textToImage' as const,
    modelId: 7,
    modelVersionId: 99,
    params: {
      prompt: 'a cat',
      quantity: 1,
    },
  };
  // checkpointVersionId === body.modelVersionId for Checkpoint-bound installs
  // (resolveBlockCheckpoint returns the model as its own anchor). For LoRAs the
  // resolver returns a different versionId — represented here. `checkpointBaseModel`
  // is the RESOLVED checkpoint's baseModel (drives the graph `ecosystem`).
  const checkpointResolved = {
    baseModel: 'SDXL 1.0',
    modelType: 'Checkpoint',
    checkpointVersionId: 99,
    checkpointBaseModel: 'SDXL 1.0',
  };
  const sd1CheckpointResolved = {
    baseModel: 'SD 1.5',
    modelType: 'Checkpoint',
    checkpointVersionId: 99,
    checkpointBaseModel: 'SD 1.5',
  };
  const fluxLoraResolved = {
    baseModel: 'Flux.1 D',
    modelType: 'LORA',
    checkpointVersionId: 691639,
    checkpointBaseModel: 'Flux.1 D',
  };

  // New shape: the function now emits the flat generation-graph `input`
  // (`{ workflow, ecosystem, model, resources, prompt, ...top-level params }`)
  // rather than the legacy `{ params, resources }` GenerateImageSchema. The
  // checkpoint is the `model` anchor; `resources` holds ONLY additional networks
  // (LoRAs). Dimensions live on `aspectRatio` (raw here — the graph's
  // aspectRatio node snaps them to a canonical bucket at validation time).

  it('derives the graph ecosystem from the resolved checkpoint baseModel', () => {
    expect(buildTextToImageInput(baseBody as never, checkpointResolved).ecosystem).toBe('SDXL');
    expect(buildTextToImageInput(baseBody as never, sd1CheckpointResolved).ecosystem).toBe('SD1');
    expect(buildTextToImageInput(baseBody as never, fluxLoraResolved).ecosystem).toBe('Flux1');
  });

  it('fills SDXL/Flux-class defaults (1024x1024) when the block omits dimensions', () => {
    const out = buildTextToImageInput(baseBody as never, checkpointResolved) as {
      aspectRatio: { width: number; height: number };
    };
    expect(out.aspectRatio.width).toBe(1024);
    expect(out.aspectRatio.height).toBe(1024);
  });

  it('fills SD1/SD2 defaults (512x512) for older base models', () => {
    const out = buildTextToImageInput(baseBody as never, sd1CheckpointResolved) as {
      aspectRatio: { width: number; height: number };
    };
    expect(out.aspectRatio.width).toBe(512);
    expect(out.aspectRatio.height).toBe(512);
  });

  it('respects block-supplied width/height when set', () => {
    const body = {
      ...baseBody,
      params: { ...baseBody.params, width: 768, height: 1152 },
    };
    const out = buildTextToImageInput(body as never, checkpointResolved) as {
      aspectRatio: { value: string; width: number; height: number };
    };
    expect(out.aspectRatio.width).toBe(768);
    expect(out.aspectRatio.height).toBe(1152);
    expect(out.aspectRatio.value).toBe('768:1152');
  });

  it('defaults sampler/steps and pins workflow to txt2img', () => {
    const out = buildTextToImageInput(baseBody as never, checkpointResolved);
    expect(out.sampler).toBe('Euler');
    expect(out.steps).toBe(25);
    expect(out.workflow).toBe('txt2img');
    expect(out.priority).toBe('low');
    expect(out.prompt).toBe('a cat');
  });

  it('puts the bound Checkpoint at `model` with no additional resources', () => {
    const out = buildTextToImageInput(baseBody as never, checkpointResolved);
    expect(out.model).toEqual({ id: 99 });
    expect(out.resources).toEqual([]);
  });

  it('anchors `model` on the resolved checkpoint and pushes the bound LoRA into resources', () => {
    const out = buildTextToImageInput(baseBody as never, fluxLoraResolved);
    // The resolver picks 691639 for Flux1 family (publisher default in this
    // fixture); the host doesn't second-guess what the resolver returned. The
    // bound LoRA (body model 99) is the only additional network.
    expect(out.model).toEqual({ id: 691639 });
    expect(out.resources).toEqual([{ id: 99, strength: 1 }]);
  });

  it('forwards block-supplied sampler/steps/seed overrides', () => {
    const body = {
      ...baseBody,
      params: { ...baseBody.params, sampler: 'DPM++ 2M Karras', steps: 30, seed: 12345 },
    };
    const out = buildTextToImageInput(body as never, checkpointResolved);
    expect(out.sampler).toBe('DPM++ 2M Karras');
    expect(out.steps).toBe(30);
    expect(out.seed).toBe(12345);
  });

  // ── Page-LoRA (Increment 1): fan additionalResources into `resources` ──────
  it('fans N additional LoRAs into the resources array (checkpoint stays on `model`)', () => {
    const body = {
      ...baseBody,
      additionalResources: [
        { modelVersionId: 201, strength: 0.8 },
        { modelVersionId: 202, strength: 1.2 },
        { modelVersionId: 203, strength: -0.5 },
      ],
    };
    const out = buildTextToImageInput(body as never, checkpointResolved);
    expect(out.model).toEqual({ id: 99 });
    expect(out.resources).toEqual([
      { id: 201, strength: 0.8 },
      { id: 202, strength: 1.2 },
      { id: 203, strength: -0.5 },
    ]);
  });

  it('does NOT duplicate the checkpoint when an additionalResource repeats it', () => {
    const body = {
      ...baseBody,
      additionalResources: [
        { modelVersionId: 99, strength: 0.7 }, // same as the checkpoint anchor (`model`)
        { modelVersionId: 201, strength: 1 },
      ],
    };
    const out = buildTextToImageInput(body as never, checkpointResolved);
    // The checkpoint stays as the `model` anchor (no double-bill); only the
    // genuinely-new LoRA lands in resources.
    expect(out.model).toEqual({ id: 99 });
    expect(out.resources).toEqual([{ id: 201, strength: 1 }]);
  });

  it('does NOT duplicate the bound-model network when the body model is a LoRA', () => {
    // fluxLoraResolved: checkpointVersionId=691639 (resolver anchor → `model`),
    // body.modelVersionId=99 is itself a LoRA pushed into resources. An
    // additionalResource repeating either id must be deduped.
    const body = {
      ...baseBody,
      additionalResources: [
        { modelVersionId: 691639, strength: 0.5 }, // == checkpoint anchor (`model`)
        { modelVersionId: 99, strength: 0.5 }, // == bound-model network
        { modelVersionId: 300, strength: 0.9 }, // genuinely new
      ],
    };
    const out = buildTextToImageInput(body as never, fluxLoraResolved);
    expect(out.model).toEqual({ id: 691639 });
    expect(out.resources).toEqual([
      { id: 99, strength: 1 },
      { id: 300, strength: 0.9 },
    ]);
  });

  it('first-wins dedupe for a LoRA that appears twice in additionalResources', () => {
    const body = {
      ...baseBody,
      additionalResources: [
        { modelVersionId: 201, strength: 0.3 },
        { modelVersionId: 201, strength: 0.9 }, // duplicate id
      ],
    };
    const out = buildTextToImageInput(body as never, checkpointResolved);
    expect(out.resources).toEqual([{ id: 201, strength: 0.3 }]); // first occurrence kept
  });

  it('emits no additional resources when additionalResources is absent', () => {
    const out = buildTextToImageInput(baseBody as never, checkpointResolved);
    expect(out.model).toEqual({ id: 99 });
    expect(out.resources).toEqual([]);
  });
});

describe('isPageLoraResource', () => {
  it('returns true for the LoRA family (LORA / LoCon / DoRA)', () => {
    expect(isPageLoraResource('LORA')).toBe(true);
    expect(isPageLoraResource('LoCon')).toBe(true);
    expect(isPageLoraResource('DoRA')).toBe(true);
  });

  it('returns false for non-LoRA types (Checkpoint / VAE / TextualInversion)', () => {
    expect(isPageLoraResource('Checkpoint')).toBe(false);
    expect(isPageLoraResource('VAE')).toBe(false);
    expect(isPageLoraResource('TextualInversion')).toBe(false);
    expect(isPageLoraResource('Upscaler')).toBe(false);
  });
});

describe('resolvePageResourceContext', () => {
  beforeEach(() => {
    mockDbRead.modelVersion.findUnique.mockReset();
  });

  it('returns the gate bag + baseModel + modelType with NO modelId binding check', async () => {
    // Note: modelId (8) intentionally differs from any "expected" model — the
    // page resolver has no binding to enforce, so this resolves successfully
    // where resolveBlockVersionContext(…, 7) would FORBIDDEN.
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 201,
      baseModel: 'SDXL 1.0',
      modelId: 8,
      status: 'Published',
      availability: 'Public',
      usageControl: 'Download',
      meta: null,
      generationCoverage: { covered: true },
      model: { id: 8, type: 'LORA', userId: 55 },
    });
    const out = await resolvePageResourceContext(201);
    expect(out).toEqual({
      modelId: 8,
      modelVersionId: 201,
      baseModel: 'SDXL 1.0',
      modelType: 'LORA',
      gate: {
        id: 201,
        status: 'Published',
        availability: 'Public',
        usageControl: 'Download',
        baseModel: 'SDXL 1.0',
        covered: true,
        modelUserId: 55,
        modelType: 'LORA',
        modelVersionAlias: null,
      },
    });
  });

  it('defaults covered to false when no generationCoverage row exists', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 201,
      baseModel: 'SDXL 1.0',
      modelId: 8,
      status: 'Published',
      availability: 'Public',
      usageControl: 'Download',
      meta: null,
      generationCoverage: null,
      model: { id: 8, type: 'LORA', userId: 55 },
    });
    const out = await resolvePageResourceContext(201);
    expect(out.gate.covered).toBe(false);
  });

  it('reads the generation alias from version.meta.generationAlias', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 201,
      baseModel: 'SDXL 1.0',
      modelId: 8,
      status: 'Published',
      availability: 'Public',
      usageControl: 'Download',
      meta: { generationAlias: { versionId: 999 } },
      generationCoverage: { covered: true },
      model: { id: 8, type: 'LORA', userId: 55 },
    });
    const out = await resolvePageResourceContext(201);
    expect(out.gate.modelVersionAlias).toEqual({ versionId: 999 });
  });

  it('throws NOT_FOUND when the version is missing', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue(null);
    await expect(resolvePageResourceContext(201)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws NOT_FOUND when the version is unpublished (no info leak)', async () => {
    mockDbRead.modelVersion.findUnique.mockResolvedValue({
      id: 201,
      baseModel: 'SDXL 1.0',
      modelId: 8,
      status: 'Draft',
      availability: 'Public',
      usageControl: 'Download',
      meta: null,
      generationCoverage: { covered: true },
      model: { id: 8, type: 'LORA', userId: 55 },
    });
    await expect(resolvePageResourceContext(201)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration-style: REAL block input → REAL graph validation → REAL params
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS (the audit's 🟡 gap): the router-level tests in
// `src/server/routers/__tests__/blocks.router.workflow.test.ts` mock
// `createWorkflowStepsFromGraphInput` WHOLESALE — they hand the router a canned
// `{ workflowMetadata }` and assert the router attaches it to the real submit
// body / omits it on whatIf. That proves the router PLUMBING but NOT the PR's
// headline claim: that REAL block input, run through the ACTUAL param-mapping,
// yields a POPULATED `workflowMetadata.params`. A regression in
// `buildTextToImageInput` or the param snapshot (e.g. dropping `prompt`/`seed`,
// or the graph silently blanking them) would leave those plumbing tests green
// while shipping blank queue/remix metadata. This closes that gap.
//
// WHAT IS REAL vs STUBBED, and why:
//   • REAL  — `buildTextToImageInput` (the block→graph-input translator under
//             test), `generationGraph.safeParse` (the EXACT validator
//             `createWorkflowStepsFromGraph` runs via `validateInput`), and
//             `toStepMetadata` + `removeEmpty` (the EXACT param-snapshot fns
//             that build `workflowMetadata.params`). This is the whole
//             param-mapping path the PR touches — nothing about how `params` is
//             derived is mocked.
//   • STUBBED (by NOT running it) — resource ENRICHMENT
//             (`validateAndEnrichResources` → `getResourceData`, a DB/network
//             lookup) and the orchestrator step-input handlers. Those are
//             external IO and do NOT contribute to `params` (params come from
//             the validated graph output minus model/resources/vae). We re-run
//             `createWorkflowStepsFromGraph`'s param logic faithfully
//             (safeParse → toStepMetadata → removeEmpty) rather than calling
//             `createWorkflowStepsFromGraphInput`, which would drag in the real
//             DB client + event-engine-common import graph (un-runnable on this
//             host, and the reason the router tests mock it wholesale).
//
// HONEST LIMITATION: this asserts the params snapshot + the CHECKPOINT in
// `resources`. It does NOT assert ADDITIONAL LoRA resources land in
// `workflowMetadata.resources`, because the graph's `resources` node requires
// the enriched ResourceData map (from `getResourceData`) to validate unknown
// version ids — without enrichment `safeParse` rejects them. Faking that map
// would prove a mock, not real behavior, so the additional-resource→metadata
// linkage is intentionally left to the (mocked) router test's
// `realBody.metadata.resources` assertion. The checkpoint anchor, which the
// graph resolves WITHOUT enrichment, IS covered here.
describe('block input yields populated workflow metadata params (real graph path)', () => {
  // A free user's generation context — the same shape `buildGenerationContext`
  // produces, hand-built so the test stays off sysRedis/DB. The graph validator
  // reads limits/tier/gateRules from this; nothing here affects how `params` is
  // snapshotted.
  const externalCtx: GenerationCtx = {
    limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
    user: { isMember: false, tier: 'free' },
    flags: {},
    selfHostedDisabledEcosystems: [],
    selfHostedMode: 'enabled',
    gateRules: [],
  };

  // Mirror of the param-snapshot CALCULATION inside
  // `createWorkflowStepsFromGraph`: validate the graph input, then
  // `removeEmpty(toStepMetadata(data).params)`. (Computed-key stripping and the
  // seed default also live there, but our body supplies a literal seed and our
  // asserted fields are all form inputs, never computed — so this faithfully
  // reproduces the `workflowMetadata.params` for this body.)
  function paramsFromRealGraph(input: Record<string, unknown>) {
    const result = generationGraph.safeParse(input, externalCtx);
    if (!result.success) {
      throw new Error(`graph validation failed: ${JSON.stringify(result.errors)}`);
    }
    const meta = toStepMetadata(result.data as never);
    return {
      params: removeEmpty(meta.params as Record<string, unknown>),
      resources: meta.resources,
    };
  }

  it('populates params (prompt/seed/sampler/cfgScale/steps) from real block input', () => {
    // A realistic form-shaped textToImage block body — the Extract<…,'textToImage'>
    // shape the iframe posts: per-image params the user set in the block UI.
    const body = {
      kind: 'textToImage' as const,
      modelId: 7,
      modelVersionId: 99,
      params: {
        prompt: 'a photo of a cat astronaut',
        negativePrompt: 'blurry, low quality',
        cfgScale: 7,
        sampler: 'Euler a',
        steps: 25,
        seed: 12345,
        quantity: 1,
      },
    };
    // checkpoint-bound install: the resolved checkpoint IS body.modelVersionId.
    const resolved = {
      baseModel: 'SDXL 1.0',
      modelType: 'Checkpoint',
      checkpointVersionId: 99,
      checkpointBaseModel: 'SDXL 1.0',
    };

    // REAL translator → REAL graph validation → REAL param snapshot.
    const input = buildTextToImageInput(body as never, resolved);
    const { params, resources } = paramsFromRealGraph(input);

    // The headline claim: params is POPULATED with the user's form fields
    // (verbatim), not blank. A regression that re-blanks block metadata fails here.
    expect(params).toMatchObject({
      workflow: 'txt2img',
      prompt: 'a photo of a cat astronaut',
      negativePrompt: 'blurry, low quality',
      cfgScale: 7,
      sampler: 'Euler a',
      steps: 25,
      seed: 12345,
      quantity: 1,
    });
    // ecosystem is derived from the checkpoint baseModel by the real translator.
    expect(params.ecosystem).toBe('SDXL');

    // The checkpoint anchor shows up in the resources snapshot (this is the part
    // of `workflowMetadata.resources` the graph resolves without enrichment).
    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 99, model: { type: 'Checkpoint' } }),
      ])
    );
  });

  it('snaps SD1 defaults and still populates params for an SD1.5 checkpoint', () => {
    // Cross-check a second ecosystem so the assertion isn't SDXL-specific: the
    // real graph must snap SD1.5 to 512² and carry the same form params through.
    const body = {
      kind: 'textToImage' as const,
      modelId: 7,
      modelVersionId: 99,
      params: { prompt: 'a dog', sampler: 'DPM++ 2M Karras', steps: 30, seed: 777, quantity: 2 },
    };
    const resolved = {
      baseModel: 'SD 1.5',
      modelType: 'Checkpoint',
      checkpointVersionId: 99,
      checkpointBaseModel: 'SD 1.5',
    };
    const input = buildTextToImageInput(body as never, resolved);
    const { params } = paramsFromRealGraph(input);
    expect(params).toMatchObject({
      workflow: 'txt2img',
      ecosystem: 'SD1',
      prompt: 'a dog',
      sampler: 'DPM++ 2M Karras',
      steps: 30,
      seed: 777,
      quantity: 2,
    });
    expect(params.aspectRatio).toMatchObject({ width: 512, height: 512 });
  });

  it('emitted img2img input validates through the REAL generation graph (SDXL)', () => {
    // Proves the generalized bridge output is graph-valid end-to-end: a bounded
    // source image → workflow:img2img with an images[] init node the SD-family
    // graph accepts (denoise applies at its default; aspectRatio is dropped).
    const body = {
      kind: 'textToImage' as const,
      modelId: 7,
      modelVersionId: 99,
      params: { prompt: 'a cat', quantity: 1 },
      sourceImage: { url: 'https://image.civitai.com/abc/def.jpeg', width: 768, height: 1024 },
    };
    const resolved = {
      baseModel: 'SDXL 1.0',
      modelType: 'Checkpoint',
      checkpointVersionId: 99,
      checkpointBaseModel: 'SDXL 1.0',
    };
    const input = buildImageWorkflowInput(body as never, resolved);
    const result = generationGraph.safeParse(input, externalCtx);
    if (!result.success) {
      throw new Error(`img2img graph validation failed: ${JSON.stringify(result.errors)}`);
    }
    expect((result.data as { workflow: string }).workflow).toBe('img2img');
    const images = (result.data as { images?: Array<{ url: string }> }).images;
    expect(images).toEqual([
      expect.objectContaining({ url: 'https://image.civitai.com/abc/def.jpeg' }),
    ]);
  });

  // Edit-capable ecosystems (EDIT_IMG_IDS) route a source-image body to
  // `img2img:edit`, NOT plain `img2img`. Prove end-to-end that the emitted input
  // validates through the REAL generation graph AND routes to img2img:edit (i.e.
  // the ecosystem is NOT silently auto-corrected) for each edit ecosystem — the
  // same `images` reference node the onsite generator feeds (openai-graph /
  // flux-kontext-graph / qwen-graph). `checkpointVersionId` uses each ecosystem's
  // real locked version id so the modelLocked graph doesn't remap it.
  it.each([
    ['OpenAI', 'OpenAI', 1733399],
    ['Qwen', 'Qwen', 2558804],
    ['Flux.1 Kontext', 'Flux1Kontext', 1892509],
  ])(
    'emitted img2img:edit input validates through the REAL graph for %s (ecosystem %s)',
    (baseModel, ecoKey, versionId) => {
      const body = {
        kind: 'textToImage' as const,
        modelId: 7,
        modelVersionId: versionId,
        params: { prompt: 'make the cat wear a hat', quantity: 1 },
        sourceImage: {
          url: 'https://image.civitai.com/abc/def.jpeg',
          width: 1024,
          height: 1024,
        },
      };
      const resolved = {
        baseModel,
        modelType: 'Checkpoint',
        checkpointVersionId: versionId,
        checkpointBaseModel: baseModel,
      };
      const input = buildImageWorkflowInput(body as never, resolved);
      // The builder routes to img2img:edit deterministically.
      expect(input.workflow).toBe('img2img:edit');
      expect(input.ecosystem).toBe(ecoKey);

      // The REAL graph accepts it AND keeps it routed to img2img:edit on the
      // asserted ecosystem (no auto-correction to a supported-but-wrong route).
      const result = generationGraph.safeParse(input, externalCtx);
      if (!result.success) {
        throw new Error(`img2img:edit graph validation failed: ${JSON.stringify(result.errors)}`);
      }
      const data = result.data as { workflow: string; ecosystem: string; images?: Array<{ url: string }> };
      expect(data.workflow).toBe('img2img:edit');
      expect(data.ecosystem).toBe(ecoKey);
      // The bounded source image rides into the graph's reference `images` node.
      expect(data.images).toEqual([
        expect.objectContaining({ url: 'https://image.civitai.com/abc/def.jpeg' }),
      ]);
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks IMAGE bridge (Phase-2a): generalized image-workflow builder
// ─────────────────────────────────────────────────────────────────────────────
describe('buildImageWorkflowInput (generalized image-workflow bridge)', () => {
  const baseBody = {
    kind: 'textToImage' as const,
    modelId: 7,
    modelVersionId: 99,
    params: { prompt: 'a cat', quantity: 1 },
  };
  const checkpointResolved = {
    baseModel: 'SDXL 1.0',
    modelType: 'Checkpoint',
    checkpointVersionId: 99,
    checkpointBaseModel: 'SDXL 1.0',
  };
  const validSourceImage = {
    url: 'https://image.civitai.com/abc/def.jpeg',
    width: 768,
    height: 1024,
  };

  it('exposes exactly the image workflow allowlist (txt2img, img2img, img2img:edit)', () => {
    expect([...BLOCK_IMAGE_WORKFLOW_TYPES]).toEqual(['txt2img', 'img2img', 'img2img:edit']);
  });

  it('resolveBlockImageWorkflowType derives the variant from body + ecosystem', () => {
    // No source image → txt2img regardless of ecosystem.
    expect(resolveBlockImageWorkflowType(baseBody as never)).toBe('txt2img');
    expect(resolveBlockImageWorkflowType(baseBody as never, ECO.OpenAI)).toBe('txt2img');
    // Source image + SD-family ecosystem → img2img.
    expect(
      resolveBlockImageWorkflowType(
        { ...baseBody, sourceImage: validSourceImage } as never,
        ECO.SDXL
      )
    ).toBe('img2img');
    // Source image + edit-capable ecosystem → img2img:edit.
    for (const eco of [ECO.OpenAI, ECO.Qwen, ECO.Flux1Kontext]) {
      expect(
        resolveBlockImageWorkflowType({ ...baseBody, sourceImage: validSourceImage } as never, eco)
      ).toBe('img2img:edit');
    }
    // Source image + ecosystem that supports neither img2img variant (Flux.1 →
    // Flux1, txt2img-only) → BAD_REQUEST.
    let caught: unknown;
    try {
      resolveBlockImageWorkflowType(
        { ...baseBody, sourceImage: validSourceImage } as never,
        ECO.Flux1
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught).toMatchObject({ code: 'BAD_REQUEST' });
    // Source image + unknown ecosystem (undefined) → BAD_REQUEST too.
    expect(() =>
      resolveBlockImageWorkflowType({ ...baseBody, sourceImage: validSourceImage } as never)
    ).toThrow(TRPCError);
  });

  it('emits workflow:img2img + an images[] init image when a source image is present', () => {
    const body = { ...baseBody, sourceImage: validSourceImage };
    const out = buildImageWorkflowInput(body as never, checkpointResolved);
    expect(out.workflow).toBe('img2img');
    // The graph's imagesNode consumes { url, width, height }.
    expect(out.images).toEqual([
      { url: 'https://image.civitai.com/abc/def.jpeg', width: 768, height: 1024 },
    ]);
    // Dimensions come from the source image in img2img → aspectRatio is omitted
    // (the SD graph gates aspectRatio to `when: !hasImages`).
    expect(out.aspectRatio).toBeUndefined();
    // The checkpoint anchor + cost-profile fields are unchanged.
    expect(out.model).toEqual({ id: 99 });
    expect(out.quantity).toBe(1);
    expect(out.priority).toBe('low');
  });

  it('emits workflow:txt2img (with aspectRatio, no images) when there is no source image', () => {
    const out = buildImageWorkflowInput(baseBody as never, checkpointResolved);
    expect(out.workflow).toBe('txt2img');
    expect(out.images).toBeUndefined();
    expect(out.aspectRatio).toMatchObject({ width: 1024, height: 1024 });
  });

  it('buildTextToImageInput is the same builder (back-compat alias) and stays txt2img-compatible', () => {
    expect(buildTextToImageInput).toBe(buildImageWorkflowInput);
    const out = buildTextToImageInput(baseBody as never, checkpointResolved);
    expect(out.workflow).toBe('txt2img');
  });

  it('rejects a non-image (explicit) workflow type fail-closed with BAD_REQUEST', () => {
    let caught: unknown;
    try {
      buildImageWorkflowInput(baseBody as never, checkpointResolved, 'txt2vid');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught).toMatchObject({ code: 'BAD_REQUEST' });
    expect((caught as TRPCError).message).toMatch(/only image workflows/);
  });

  it('preserves the LoRA-stack fan-out on the img2img path (gates + resources unchanged)', () => {
    // The additionalResources fan-out (each entry gated per-item upstream in the
    // router) must apply identically whether or not a source image is present —
    // generalizing the builder must not drop the resource path.
    const body = {
      ...baseBody,
      sourceImage: validSourceImage,
      additionalResources: [
        { modelVersionId: 201, strength: 0.8 },
        { modelVersionId: 202, strength: 1.2 },
      ],
    };
    const out = buildImageWorkflowInput(body as never, checkpointResolved);
    expect(out.workflow).toBe('img2img');
    expect(out.model).toEqual({ id: 99 });
    expect(out.resources).toEqual([
      { id: 201, strength: 0.8 },
      { id: 202, strength: 1.2 },
    ]);
    // The init image rides alongside the resources — both are present.
    expect(out.images).toHaveLength(1);
  });

  it('carries the same cost-profile fields on img2img as txt2img (budget preflight sees the same shape)', () => {
    // The router's budget preflight costs the built input via the orchestrator
    // whatIf. Generalizing to img2img must not change the fields that drive cost
    // (quantity / priority / prompt / resources) — only add the init image.
    const txt = buildImageWorkflowInput(baseBody as never, checkpointResolved);
    const img = buildImageWorkflowInput(
      { ...baseBody, sourceImage: validSourceImage } as never,
      checkpointResolved
    );
    for (const key of ['quantity', 'priority', 'prompt', 'model', 'resources', 'ecosystem']) {
      expect(img[key]).toEqual(txt[key]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks IMAGE bridge: img2img variant selection + fail-close guard
//
// Plain `img2img` ("Image Variations") is SD-family-only and `img2img:edit` is
// EDIT_IMG_IDS-only (OpenAI/Qwen/Flux Kontext/…) in the generation graph.
// buildImageWorkflowInput must (a) route SD-family checkpoints to `img2img`, (b)
// route edit-capable checkpoints to `img2img:edit`, and (c) reject a checkpoint
// whose ecosystem supports NEITHER variant with BAD_REQUEST — deterministically,
// rather than let DataGraph.safeParse silently auto-correct the ecosystem and
// return a mis-routed graph as success.
// ─────────────────────────────────────────────────────────────────────────────
describe('buildImageWorkflowInput img2img variant selection + ecosystem guard', () => {
  const baseBody = {
    kind: 'textToImage' as const,
    modelId: 7,
    modelVersionId: 99,
    params: { prompt: 'a cat', quantity: 1 },
    sourceImage: { url: 'https://image.civitai.com/abc/def.jpeg', width: 768, height: 1024 },
  };
  const resolved = (checkpointBaseModel: string) => ({
    baseModel: checkpointBaseModel,
    modelType: 'Checkpoint',
    checkpointVersionId: 99,
    checkpointBaseModel,
  });

  // baseModel → expected graph ecosystem key. These are the SD-family members
  // configured for plain img2img (SD_FAMILY_IDS).
  it.each([
    ['SDXL 1.0', 'SDXL'],
    ['SD 1.5', 'SD1'],
    ['Pony', 'Pony'],
    ['Illustrious', 'Illustrious'],
    ['NoobAI', 'NoobAI'],
  ])('builds img2img for SD-family checkpoint %s (ecosystem %s)', (baseModel, ecoKey) => {
    const out = buildImageWorkflowInput(baseBody as never, resolved(baseModel));
    expect(out.workflow).toBe('img2img');
    expect(out.ecosystem).toBe(ecoKey);
    expect(out.images).toHaveLength(1);
  });

  // Edit-capable checkpoints (EDIT_IMG_IDS): plain img2img is NOT available but
  // img2img:edit IS — the builder must route them to `img2img:edit` (NOT reject,
  // NOT silently SD1-correct) and still carry the source image.
  it.each([
    ['Flux.1 Kontext', 'Flux1Kontext'],
    ['Qwen', 'Qwen'],
    ['OpenAI', 'OpenAI'],
  ])('builds img2img:edit for edit-capable checkpoint %s (ecosystem %s)', (baseModel, ecoKey) => {
    const out = buildImageWorkflowInput(baseBody as never, resolved(baseModel));
    expect(out.workflow).toBe('img2img:edit');
    expect(out.ecosystem).toBe(ecoKey);
    expect(out.images).toHaveLength(1);
    // aspectRatio is omitted for the edit variant (graph default applies).
    expect(out.aspectRatio).toBeUndefined();
  });

  // Checkpoints whose ecosystem supports NEITHER img2img variant: the builder
  // must throw BAD_REQUEST (not silently emit an auto-corrected graph). Flux.1 D
  // (Flux1) / Chroma are txt2img-only; SD 3.5 / SD 2.1 are in neither set.
  it.each(['Flux.1 D', 'SD 3.5', 'Chroma', 'SD 2.1'])(
    'rejects img2img for a no-img2img-variant checkpoint %s with BAD_REQUEST',
    (baseModel) => {
      let caught: unknown;
      try {
        buildImageWorkflowInput(baseBody as never, resolved(baseModel));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(TRPCError);
      expect(caught).toMatchObject({ code: 'BAD_REQUEST' });
      expect((caught as TRPCError).message).toMatch(/not supported/);
    }
  );

  it('still builds txt2img (no source image) for a non-SD-family checkpoint (guard is img2img-only)', () => {
    // The guard must not affect the txt2img path — a Flux block with no source
    // image is unchanged.
    const { sourceImage, ...txtBody } = baseBody;
    void sourceImage;
    const out = buildImageWorkflowInput(txtBody as never, resolved('Flux.1 D'));
    expect(out.workflow).toBe('txt2img');
    expect(out.ecosystem).toBe('Flux1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks IMAGE bridge (Phase-2a): source-image URL bound (untrusted iframe)
// ─────────────────────────────────────────────────────────────────────────────
describe('blockWorkflowBodySchema sourceImage bound (SSRF / arbitrary-URL guard)', () => {
  const baseBody = {
    kind: 'textToImage' as const,
    modelId: 7,
    modelVersionId: 99,
    params: { prompt: 'a cat', quantity: 1 },
  };
  function parseWithSource(url: string) {
    return blockWorkflowBodySchema.safeParse({
      ...baseBody,
      sourceImage: { url, width: 768, height: 1024 },
    });
  }

  it('accepts a body with NO source image (byte-compatible txt2img path)', () => {
    const res = blockWorkflowBodySchema.safeParse(baseBody);
    expect(res.success).toBe(true);
  });

  it('accepts a Civitai-hosted https source image (orchestrator / CDN / apex)', () => {
    expect(parseWithSource('https://orchestration.civitai.com/v2/blobs/abc.jpeg').success).toBe(
      true
    );
    expect(parseWithSource('https://image.civitai.com/abc/def.jpeg').success).toBe(true);
    expect(parseWithSource('https://civitai.com/images/xyz.jpeg').success).toBe(true);
    expect(parseWithSource('https://image.civitai.red/abc/def.jpeg').success).toBe(true);
  });

  it('rejects an arbitrary/remote source-image URL', () => {
    expect(parseWithSource('https://evil.example/x.png').success).toBe(false);
    expect(parseWithSource('https://cdn.attacker.io/leak.png').success).toBe(false);
  });

  it('rejects a non-https URL (no http SSRF)', () => {
    expect(parseWithSource('http://image.civitai.com/abc.jpeg').success).toBe(false);
    expect(parseWithSource('ftp://image.civitai.com/abc.jpeg').success).toBe(false);
  });

  it('rejects a host-confusion URL that merely CONTAINS a civitai host as a substring', () => {
    // The bound is hostname-based, not substring — so this attacker origin is
    // rejected where a `.includes("image.civitai.com")` check would accept it.
    expect(parseWithSource('https://evil.example/?x=image.civitai.com').success).toBe(false);
    expect(parseWithSource('https://image.civitai.com.evil.example/x.png').success).toBe(false);
  });

  it('rejects out-of-bound source-image dimensions', () => {
    expect(
      blockWorkflowBodySchema.safeParse({
        ...baseBody,
        sourceImage: { url: 'https://image.civitai.com/a.jpeg', width: 99999, height: 1024 },
      }).success
    ).toBe(false);
  });
});
