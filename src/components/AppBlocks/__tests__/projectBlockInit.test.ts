import { describe, expect, it } from 'vitest';
import { projectBlockInitContext, projectBlockInitViewer } from '../projectBlockInit';
import type { BlockCheckpointInfo, ModelSlotContext, ShowcaseImage } from '../types';

/**
 * BLOCK_INIT data-minimization (security audit — MEDIUM).
 *
 * The host posts BLOCK_INIT to the untrusted third-party publisher iframe.
 * projectBlockInitContext / projectBlockInitViewer are the pure allowlist
 * projections that ensure the payload carries ONLY contract fields and never
 * the incidental PII / internal ids that ride along on the host SlotContext.
 *
 * These tests pin the keep/drop contract so a future field added to
 * SlotContext can't silently leak to the iframe.
 */

const checkpoint: BlockCheckpointInfo = {
  versionId: 999,
  modelId: 50,
  modelName: 'Some Checkpoint',
  versionName: 'v1',
  baseModel: 'Flux.1 D',
};

const showcaseImages: ShowcaseImage[] = [
  {
    id: 1,
    url: 'https://example.com/1.jpg',
    width: 512,
    height: 512,
    prompt: 'a cat',
    negativePrompt: null,
    cfgScale: 7,
    steps: 20,
    seed: 42,
    sampler: 'Euler',
    clipSkip: 2,
  },
];

// A fully-populated model slot context as produced by ModelVersionDetails —
// includes both the contract fields AND the over-share fields the projection
// must drop.
const fullContext: ModelSlotContext = {
  slotId: 'model.sidebar_top',
  modelId: 123,
  modelVersionId: 456,
  modelName: 'My Model',
  modelType: 'Checkpoint',
  modelNsfwLevel: 1,
  // --- over-share fields, all must be dropped ---
  creatorUserId: 7777,
  viewerUserId: 8888,
  viewerNsfwEnabled: true,
  viewerUsername: 'alice',
  viewerStatus: 'active',
  theme: 'dark',
};

describe('projectBlockInitContext (BLOCK_INIT context allowlist)', () => {
  it('DROPS privacy/internal fields: viewerNsfwEnabled, creatorUserId, and duplicated viewer ids/status/username', () => {
    const projected = projectBlockInitContext(fullContext, { checkpoint, showcaseImages });

    expect(projected).not.toHaveProperty('viewerNsfwEnabled');
    expect(projected).not.toHaveProperty('creatorUserId');
    expect(projected).not.toHaveProperty('viewerUserId');
    expect(projected).not.toHaveProperty('viewerStatus');
    expect(projected).not.toHaveProperty('viewerUsername');
  });

  it('KEEPS allowlisted model-rendering + presentation fields, unchanged', () => {
    const projected = projectBlockInitContext(fullContext, { checkpoint, showcaseImages });

    expect(projected.slotId).toBe('model.sidebar_top');
    expect(projected.modelId).toBe(123);
    expect(projected.modelVersionId).toBe(456);
    expect(projected.modelName).toBe('My Model');
    expect(projected.modelType).toBe('Checkpoint');
    expect(projected.modelNsfwLevel).toBe(1);
    expect(projected.theme).toBe('dark');
  });

  it('layers in the host-resolved checkpoint + showcaseImages extras', () => {
    const projected = projectBlockInitContext(fullContext, { checkpoint, showcaseImages });

    expect(projected.checkpoint).toEqual(checkpoint);
    expect(projected.showcaseImages).toEqual(showcaseImages);
  });

  it('exposes EXACTLY the allowlisted keys — no extra leakage', () => {
    const projected = projectBlockInitContext(fullContext, { checkpoint, showcaseImages });

    expect(Object.keys(projected).sort()).toEqual(
      [
        'checkpoint',
        'modelId',
        'modelNsfwLevel',
        'modelName',
        'modelType',
        'modelVersionId',
        'showcaseImages',
        'slotId',
        'theme',
      ].sort()
    );
  });

  it('host-resolved extras override any producer-set checkpoint/showcaseImages on the context', () => {
    const tampered = {
      ...fullContext,
      // A producer (or malicious upstream) setting these on the context must
      // not win over the host-authoritative extras.
      checkpoint: { ...checkpoint, modelName: 'SPOOFED' },
      showcaseImages: [],
    } as ModelSlotContext;

    const projected = projectBlockInitContext(tampered, { checkpoint, showcaseImages });
    expect(projected.checkpoint).toEqual(checkpoint);
    expect(projected.showcaseImages).toEqual(showcaseImages);
  });

  it('does not mutate the input context', () => {
    const input = { ...fullContext };
    projectBlockInitContext(input, { checkpoint, showcaseImages });
    expect(input).toEqual(fullContext);
    // over-share fields still present on the source (we returned a fresh object)
    expect(input.creatorUserId).toBe(7777);
    expect(input.viewerNsfwEnabled).toBe(true);
  });

  it('omits absent optional fields (non-model / minimal slot context)', () => {
    const projected = projectBlockInitContext(
      { slotId: 'model.below_images' },
      { checkpoint: null, showcaseImages: [] }
    );
    expect(projected.slotId).toBe('model.below_images');
    expect(projected).not.toHaveProperty('modelId');
    expect(projected).not.toHaveProperty('theme');
    // extras always present (explicitly set by the host)
    expect(projected.checkpoint).toBeNull();
    expect(projected.showcaseImages).toEqual([]);
  });
});

describe('projectBlockInitViewer (BLOCK_INIT viewer allowlist)', () => {
  it('builds the viewer from id/username only — no nsfw pref, creator id, or moderation status leak', () => {
    const viewer = projectBlockInitViewer(fullContext);
    expect(viewer).toEqual({ id: 8888, username: 'alice' });
    // the viewer object exposes exactly id + username; status (ban/mute) is dropped
    expect(Object.keys(viewer ?? {}).sort()).toEqual(['id', 'username']);
    expect(viewer).not.toHaveProperty('status');
  });

  it('defaults username to null when absent (and never adds status)', () => {
    const viewer = projectBlockInitViewer({
      slotId: 'model.sidebar_top',
      viewerUserId: 1,
    } as ModelSlotContext);
    expect(viewer).toEqual({ id: 1, username: null });
  });

  it('returns null for anonymous viewers (no numeric viewerUserId)', () => {
    expect(
      projectBlockInitViewer({ slotId: 'model.sidebar_top', viewerUserId: null } as ModelSlotContext)
    ).toBeNull();
    expect(projectBlockInitViewer({ slotId: 'model.sidebar_top' })).toBeNull();
  });
});
