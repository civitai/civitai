import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * Coverage for the publish-time generator validation service (Custom Generators
 * PR-B G7 + backgroundImageRef). Mocks the dynamically-imported generation gate
 * (`resolveCanGenerateForVersions`) and the stateless resource resolver
 * (`resolvePageResourceContext`) so the fail-closed behaviour is pinned without a
 * DB, and mocks `dbRead.image` for the background-image check.
 */

const {
  mockResolveCanGenerate,
  mockResolvePageResource,
  mockImageFindUnique,
} = vi.hoisted(() => ({
  mockResolveCanGenerate: vi.fn(),
  mockResolvePageResource: vi.fn(),
  mockImageFindUnique: vi.fn(),
}));

vi.mock('~/server/services/generation/generation.service', () => ({
  resolveCanGenerateForVersions: (...a: unknown[]) => mockResolveCanGenerate(...a),
}));
vi.mock('~/server/services/blocks/workflow.service', () => ({
  resolvePageResourceContext: (...a: unknown[]) => mockResolvePageResource(...a),
}));
vi.mock('~/server/db/client', () => ({
  dbRead: { image: { findUnique: (...a: unknown[]) => mockImageFindUnique(...a) } },
}));

import {
  assertGeneratorResourceStackGeneratable,
  validateGeneratorBackgroundImage,
} from '../generator-publish.service';
import type { GeneratorValue } from '~/server/schema/apps/generator-value.schema';

function gen(over: Partial<GeneratorValue> = {}): GeneratorValue {
  return {
    name: 'G',
    buttons: [
      {
        label: 'A',
        workflowType: 'textToImage',
        checkpointVersionId: 100,
        loras: [{ versionId: 200, weight: 1 }],
        promptTemplate: '',
        params: { quantity: 1 },
        exposedInputs: {},
      },
    ],
    ...over,
  } as GeneratorValue;
}

// A gate bag shaped like resolvePageResourceContext's return (only `id` is read
// by the assertion; the rest is passed opaquely to the mocked gate).
const gateFor = (id: number) => ({
  gate: {
    id,
    status: 'Published',
    availability: 'Public',
    usageControl: 'Everyone',
    baseModel: 'SDXL 1.0',
    covered: true,
    modelUserId: 1,
    modelType: 'Checkpoint',
    modelVersionAlias: null,
  },
});

const viewer = { id: 42, isModerator: false };

beforeEach(() => {
  vi.clearAllMocks();
  mockResolvePageResource.mockImplementation(async (id: number) => gateFor(id));
});

describe('G7 — assertGeneratorResourceStackGeneratable', () => {
  it('ACCEPTS an all-generatable stack (checkpoint + lora)', async () => {
    mockResolveCanGenerate.mockResolvedValue(
      new Map([
        [100, { canGenerate: true }],
        [200, { canGenerate: true }],
      ])
    );
    await expect(
      assertGeneratorResourceStackGeneratable({ generator: gen(), viewer })
    ).resolves.toBeUndefined();
    // Both distinct version ids were resolved + gated.
    expect(mockResolvePageResource).toHaveBeenCalledTimes(2);
    const gatedIds = (mockResolveCanGenerate.mock.calls[0][0] as Array<{ id: number }>)
      .map((g) => g.id)
      .sort((a, b) => a - b);
    expect(gatedIds).toEqual([100, 200]);
  });

  it('REJECTS (FORBIDDEN) when one pinned versionId is non-generatable', async () => {
    mockResolveCanGenerate.mockResolvedValue(
      new Map([
        [100, { canGenerate: true }],
        [200, { canGenerate: false }], // the LoRA is not generatable
      ])
    );
    await expect(
      assertGeneratorResourceStackGeneratable({ generator: gen(), viewer })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('FAIL-CLOSED when a versionId is missing from the gate result Map', async () => {
    mockResolveCanGenerate.mockResolvedValue(new Map([[100, { canGenerate: true }]])); // 200 absent
    await expect(
      assertGeneratorResourceStackGeneratable({ generator: gen(), viewer })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('propagates NOT_FOUND from an unpublished/missing version (resolver throws)', async () => {
    mockResolvePageResource.mockImplementation(async (id: number) => {
      if (id === 200) throw new TRPCError({ code: 'NOT_FOUND', message: 'model version not found' });
      return gateFor(id);
    });
    await expect(
      assertGeneratorResourceStackGeneratable({ generator: gen(), viewer })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The gate is never consulted once a resource fails to resolve.
    expect(mockResolveCanGenerate).not.toHaveBeenCalled();
  });

  it('gates EVERY distinct resource across multiple buttons (de-duped)', async () => {
    const g = gen({
      buttons: [
        {
          label: 'A',
          workflowType: 'textToImage',
          checkpointVersionId: 100,
          loras: [{ versionId: 200, weight: 1 }],
          promptTemplate: '',
          params: { quantity: 1 },
          exposedInputs: {},
        },
        {
          label: 'B',
          workflowType: 'textToImage',
          checkpointVersionId: 100, // duplicate checkpoint
          loras: [{ versionId: 300, weight: 1 }],
          promptTemplate: '',
          params: { quantity: 1 },
          exposedInputs: {},
        },
      ] as GeneratorValue['buttons'],
    });
    mockResolveCanGenerate.mockResolvedValue(
      new Map([
        [100, { canGenerate: true }],
        [200, { canGenerate: true }],
        [300, { canGenerate: true }],
      ])
    );
    await assertGeneratorResourceStackGeneratable({ generator: g, viewer });
    expect(mockResolvePageResource).toHaveBeenCalledTimes(3); // 100, 200, 300 (100 de-duped)
  });
});

describe('backgroundImageRef — validateGeneratorBackgroundImage', () => {
  it('accepts a Scanned, SFW, unflagged image', async () => {
    // NsfwLevel.PG = 1 → SFW.
    mockImageFindUnique.mockResolvedValue({
      id: 5,
      ingestion: 'Scanned',
      nsfwLevel: 1,
      tosViolation: false,
      needsReview: null,
    });
    await expect(validateGeneratorBackgroundImage('5')).resolves.toBeUndefined();
  });

  it('rejects a non-numeric ref (BAD_REQUEST) before any query', async () => {
    await expect(validateGeneratorBackgroundImage('abc')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mockImageFindUnique).not.toHaveBeenCalled();
  });

  it('rejects a missing image (NOT_FOUND)', async () => {
    mockImageFindUnique.mockResolvedValue(null);
    await expect(validateGeneratorBackgroundImage('5')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a still-scanning image (BAD_REQUEST)', async () => {
    mockImageFindUnique.mockResolvedValue({
      id: 5,
      ingestion: 'Pending',
      nsfwLevel: 1,
      tosViolation: false,
      needsReview: null,
    });
    await expect(validateGeneratorBackgroundImage('5')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects a tosViolation image even if Scanned + SFW (BAD_REQUEST)', async () => {
    mockImageFindUnique.mockResolvedValue({
      id: 5,
      ingestion: 'Scanned',
      nsfwLevel: 1,
      tosViolation: true,
      needsReview: null,
    });
    await expect(validateGeneratorBackgroundImage('5')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects a needsReview image even if Scanned + SFW (BAD_REQUEST)', async () => {
    mockImageFindUnique.mockResolvedValue({
      id: 5,
      ingestion: 'Scanned',
      nsfwLevel: 1,
      tosViolation: false,
      needsReview: 'poi',
    });
    await expect(validateGeneratorBackgroundImage('5')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects an NSFW image above the SFW ceiling (BAD_REQUEST)', async () => {
    // NsfwLevel.XXX = 16 → not SFW.
    mockImageFindUnique.mockResolvedValue({
      id: 5,
      ingestion: 'Scanned',
      nsfwLevel: 16,
      tosViolation: false,
      needsReview: null,
    });
    await expect(validateGeneratorBackgroundImage('5')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
