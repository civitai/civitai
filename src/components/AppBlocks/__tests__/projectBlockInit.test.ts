import { describe, expect, it } from 'vitest';
import {
  projectBlockInitContext,
  projectBlockInitMaturity,
  projectBlockInitViewer,
  withSignedInFlag,
} from '../projectBlockInit';
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
    expect(viewer).toEqual({ id: 8888, username: 'alice', signedIn: true });
    // The viewer object exposes EXACTLY id + username + signedIn; status
    // (ban/mute) is dropped. Deliberately an exact-set assertion, not a subset:
    // a subset check would let a future field leak in unnoticed, which is the
    // whole failure mode this projection exists to prevent.
    expect(Object.keys(viewer ?? {}).sort()).toEqual(['id', 'signedIn', 'username']);
    expect(viewer).not.toHaveProperty('status');
  });

  /**
   * v2 `signedIn` — the forward-looking MINIMAL viewer signal.
   *
   * `id`/`username` are deprecated (identity disclosed unconditionally at load,
   * with no audit trail — `GET_VIEWER` is the replacement) but still sent: the
   * `isValidBlockInitPayload` guard compiled into every deployed bundle rejects
   * a viewer that is not `null`-or-an-object-with-numeric-`id`, and 5 of the 9
   * live apps read `viewer.id` for load-bearing logic.
   */
  it('stamps signedIn: true — literally true, not a computed boolean', () => {
    const viewer = projectBlockInitViewer(fullContext);
    // `toBe(true)` and not a truthiness check: the contract is the LITERAL
    // `true`, so a `signedIn: 1` / `signedIn: 'yes'` regression must fail here.
    expect(viewer?.signedIn).toBe(true);
  });

  it('keeps the deprecated id/username correct and un-swapped alongside signedIn', () => {
    // Pairwise-distinct fixture values: the numeric id and the username share no
    // representation, so an implementation that transposes the two operands
    // cannot produce a passing result by coincidence.
    const viewer = projectBlockInitViewer({
      slotId: 'model.sidebar_top',
      viewerUserId: 5150,
      viewerUsername: 'zephyr-quill',
    } as ModelSlotContext);
    expect(viewer?.id).toBe(5150);
    expect(viewer?.username).toBe('zephyr-quill');
  });

  it('defaults username to null when absent (and never adds status)', () => {
    const viewer = projectBlockInitViewer({
      slotId: 'model.sidebar_top',
      viewerUserId: 6021,
    } as ModelSlotContext);
    expect(viewer).toEqual({ id: 6021, username: null, signedIn: true });
  });

  it('returns null for anonymous viewers (no numeric viewerUserId)', () => {
    // Anonymous is the ABSENCE of the object, never `{ signedIn: false }` — the
    // deployed guard accepts only `null` or an object with a numeric `id`.
    expect(
      projectBlockInitViewer({ slotId: 'model.sidebar_top', viewerUserId: null } as ModelSlotContext)
    ).toBeNull();
    expect(projectBlockInitViewer({ slotId: 'model.sidebar_top' })).toBeNull();
    // A non-numeric id must NOT slip through as a signed-in viewer: a string id
    // fails the deployed guard and blanks the block.
    expect(
      projectBlockInitViewer({
        slotId: 'model.sidebar_top',
        viewerUserId: '7314' as unknown as number,
      } as ModelSlotContext)
    ).toBeNull();
  });
});

/**
 * `withSignedInFlag` — the SHARED stamper both hosts route through.
 *
 * 🔴 IT EXISTS BECAUSE THERE ARE TWO PRODUCERS OF THE BLOCK_INIT `viewer`
 * OBJECT. IframeHost derives it from the slot context (`projectBlockInitViewer`
 * above); PageBlockHost receives an already-resolved `viewer` PROP from the
 * /apps/run/[slug] route and never calls that projection at all. A flag stamped
 * only inside the projection reaches exactly half the fleet. These tests pin the
 * helper's contract; the per-surface `.browser.test.tsx` files pin that each
 * host actually goes through it.
 */
describe('withSignedInFlag (shared BLOCK_INIT viewer stamper)', () => {
  it('stamps signedIn: true and passes id/username through unchanged', () => {
    expect(withSignedInFlag({ id: 4207, username: 'marigold-vex' })).toEqual({
      id: 4207,
      username: 'marigold-vex',
      signedIn: true,
    });
  });

  it('emits EXACTLY id + username + signedIn — no extra keys', () => {
    const stamped = withSignedInFlag({ id: 9133, username: 'okonkwo-drift' });
    expect(Object.keys(stamped ?? {}).sort()).toEqual(['id', 'signedIn', 'username']);
    expect(stamped?.signedIn).toBe(true);
  });

  it('maps anonymous (null / undefined) to null — never an object with signedIn: false', () => {
    expect(withSignedInFlag(null)).toBeNull();
    expect(withSignedInFlag(undefined)).toBeNull();
  });

  it('preserves a null username without inventing one', () => {
    expect(withSignedInFlag({ id: 2758, username: null })).toEqual({
      id: 2758,
      username: null,
      signedIn: true,
    });
  });

  it('does not mutate the caller’s viewer object (the hosts hold it as a prop)', () => {
    const source = { id: 3866, username: 'halcyon-brisk' };
    withSignedInFlag(source);
    expect(source).toEqual({ id: 3866, username: 'halcyon-brisk' });
    expect(source).not.toHaveProperty('signedIn');
  });
});

/**
 * BLOCK_INIT maturity signal projection (advisory — block self-filtering/blur).
 * The values are the server-authoritative ones from the token mint; the host
 * forwards them. The projection sanitizes / fails closed so junk never reaches
 * the iframe.
 */
describe('projectBlockInitMaturity', () => {
  it('forwards a green SFW signal', () => {
    expect(projectBlockInitMaturity({ domain: 'green', maxBrowsingLevel: 3 })).toEqual({
      domain: 'green',
      maxBrowsingLevel: 3,
    });
  });

  it('forwards a red mature signal', () => {
    expect(projectBlockInitMaturity({ domain: 'red', maxBrowsingLevel: 31 })).toEqual({
      domain: 'red',
      maxBrowsingLevel: 31,
    });
  });

  it('coerces an unrecognized domain to null', () => {
    expect(projectBlockInitMaturity({ domain: 'purple', maxBrowsingLevel: 3 }).domain).toBeNull();
  });

  it('maps a missing/null domain to null', () => {
    expect(projectBlockInitMaturity({ domain: null }).domain).toBeNull();
    expect(projectBlockInitMaturity({}).domain).toBeNull();
  });

  it('drops a non-numeric / absent ceiling (undefined → SDK fails closed)', () => {
    expect(projectBlockInitMaturity({ domain: 'green' }).maxBrowsingLevel).toBeUndefined();
    expect(
      projectBlockInitMaturity({ domain: 'green', maxBrowsingLevel: NaN }).maxBrowsingLevel
    ).toBeUndefined();
    expect(
      projectBlockInitMaturity({
        domain: 'green',
        maxBrowsingLevel: 'x' as unknown as number,
      }).maxBrowsingLevel
    ).toBeUndefined();
  });
});
