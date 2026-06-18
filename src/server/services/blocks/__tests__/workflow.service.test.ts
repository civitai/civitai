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
  resolveBlockVersionContext,
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
  // (resolveBlockCheckpoint returns the model as its own anchor). For LoRAs
  // the resolver returns a different versionId — represented here.
  const checkpointResolved = {
    baseModel: 'SDXL 1.0',
    modelType: 'Checkpoint',
    checkpointVersionId: 99,
  };
  const sd1CheckpointResolved = {
    baseModel: 'SD 1.5',
    modelType: 'Checkpoint',
    checkpointVersionId: 99,
  };
  const fluxLoraResolved = {
    baseModel: 'Flux.1 D',
    modelType: 'LORA',
    checkpointVersionId: 691639,
  };

  it('fills SDXL/Flux-class defaults (1024x1024) when the block omits dimensions', () => {
    const out = buildTextToImageInput(baseBody as never, checkpointResolved);
    expect(out.params.width).toBe(1024);
    expect(out.params.height).toBe(1024);
  });

  it('fills SD1/SD2 defaults (512x512) for older base models', () => {
    const out = buildTextToImageInput(baseBody as never, sd1CheckpointResolved);
    expect(out.params.width).toBe(512);
    expect(out.params.height).toBe(512);
  });

  it('respects block-supplied width/height when set', () => {
    const body = {
      ...baseBody,
      params: { ...baseBody.params, width: 768, height: 1152 },
    };
    const out = buildTextToImageInput(body as never, checkpointResolved);
    expect(out.params.width).toBe(768);
    expect(out.params.height).toBe(1152);
  });

  it('defaults sampler/steps and pins workflow to txt2img', () => {
    const out = buildTextToImageInput(baseBody as never, checkpointResolved);
    expect(out.params.sampler).toBe('Euler');
    expect(out.params.steps).toBe(25);
    expect(out.params.workflow).toBe('txt2img');
    expect(out.params.priority).toBe('low');
    expect(out.params.draft).toBe(false);
    expect(out.params.sourceImage).toBeNull();
  });

  it('passes the bound model alone when it is itself a Checkpoint', () => {
    const out = buildTextToImageInput(baseBody as never, checkpointResolved);
    expect(out.resources).toEqual([{ id: 99, strength: 1 }]);
  });

  it('prepends the resolved checkpoint when the bound model is a LoRA', () => {
    const out = buildTextToImageInput(baseBody as never, fluxLoraResolved);
    // Resolver-supplied anchor first, then the LoRA the block is bound to.
    // The resolver picks 691639 for Flux1 family (publisher default in this
    // fixture); the host doesn't second-guess what the resolver returned.
    expect(out.resources).toEqual([
      { id: 691639, strength: 1 },
      { id: 99, strength: 1 },
    ]);
  });

  it('forwards block-supplied sampler/steps/seed overrides', () => {
    const body = {
      ...baseBody,
      params: { ...baseBody.params, sampler: 'DPM++ 2M Karras', steps: 30, seed: 12345 },
    };
    const out = buildTextToImageInput(body as never, checkpointResolved);
    expect(out.params.sampler).toBe('DPM++ 2M Karras');
    expect(out.params.steps).toBe(30);
    expect(out.params.seed).toBe(12345);
  });
});
