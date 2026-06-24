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
  buildTextToImageInput,
  isPageLoraResource,
  resolveBlockVersionContext,
  resolvePageResourceContext,
  snapshotFromWorkflow,
} from '../workflow.service';

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
