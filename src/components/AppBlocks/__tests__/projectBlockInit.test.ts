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
   * CURRENTLY-APPROVED apps read `viewer.id` for load-bearing logic. (9 =
   * the executed/served set; the deployed population a compatibility claim must
   * cover is 21 rows / 20 deployments — see the population note above
   * `BlockInitPayload` in ../types.ts.)
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
      projectBlockInitViewer({
        slotId: 'model.sidebar_top',
        viewerUserId: null,
      } as ModelSlotContext)
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

  /**
   * 🔴 `undefined` username → EXPLICIT `null`, never an absent key.
   *
   * `undefined` object values are DROPPED by structured clone, so a passed-through
   * `undefined` reaches the block as a MISSING `username` — and the deployed
   * `isValidBlockInitPayload` guard treats missing and `null` differently: an
   * explicit `null` is accepted, an absent key is REJECTED, which blanks the
   * block entirely. (An earlier draft cited "16 of 16 extracted guards"; 16
   * reconciles with none of the enumerated populations and has been withdrawn —
   * see the helper's docstring in ../projectBlockInit.ts.)
   *
   * The parameter type forbids `undefined` and BOTH call sites arrive coalesced
   * (`projectBlockInitViewer` coalesces itself; `PageBlockHost` relies on the
   * /apps/run route doing it), so this is unreachable TODAY — the point is that
   * this helper is the single choke point both hosts funnel through, one of them
   * on a guarantee held by a route this module does not own, and the whole PR
   * rests on the deployed guard being unforgiving.
   */
  it('🔴 coalesces an undefined username to an explicit null (an ABSENT key fails the deployed guard)', () => {
    const stamped = withSignedInFlag({
      id: 1471,
      username: undefined as unknown as string | null,
    });
    expect(stamped?.username).toBeNull();
    // `toBeNull()` alone passes on `undefined` under `toEqual` semantics elsewhere,
    // so pin the KEY's presence too — that is the property the guard reads.
    expect(Object.keys(stamped ?? {})).toContain('username');
    expect(stamped).toEqual({ id: 1471, username: null, signedIn: true });
    // Belt and braces: prove it survives the postMessage serialisation that
    // motivates the coalesce. `undefined` would vanish here; `null` does not.
    expect(JSON.parse(JSON.stringify(stamped))).toHaveProperty('username', null);
  });

  /**
   * 🔴 THE ANTI-SPREAD PROBE — feeds a viewer object WIDER than any host produces.
   *
   * Every other assertion in this describe uses a `{ id, username }` fixture, so
   * `{ ...viewer, signedIn: true }` satisfies all of them: with a narrow input a
   * spread and an explicit pick are indistinguishable, and the module's
   * data-minimisation docstring would then hold only by accident of the fixture
   * shape. This test makes the difference observable. `PageBlockHost` hands this
   * helper a viewer object it did NOT build (a prop from the /apps/run/[slug]
   * route), so "the caller's object only ever has two keys" is not a property this
   * module controls.
   *
   * The extra fields are modelled on real over-share hazards — the moderation
   * state and NSFW preference `projectBlockInitContext` already drops, plus a
   * credential-shaped one — rather than a neutral `foo: 'bar'`.
   */
  it('🔴 PICKS id/username/signedIn — a WIDER viewer object does not spread through', () => {
    const wideViewer = {
      id: 3094,
      username: 'sable-thorne',
      // None of these may reach untrusted publisher code.
      status: 'muted',
      email: 'sable-thorne@example.invalid',
      nsfwEnabled: true,
      sessionToken: 'sess_do_not_forward_5821',
    };

    const stamped = withSignedInFlag(wideViewer);

    // Exact-set, not a subset: a subset check is what let the spread hide.
    expect(Object.keys(stamped ?? {}).sort()).toEqual(['id', 'signedIn', 'username']);
    expect(stamped).not.toHaveProperty('status');
    expect(stamped).not.toHaveProperty('email');
    expect(stamped).not.toHaveProperty('nsfwEnabled');
    expect(stamped).not.toHaveProperty('sessionToken');
    // The contract fields still come through correctly (a projection that dropped
    // everything would also pass the assertions above).
    expect(stamped).toEqual({ id: 3094, username: 'sable-thorne', signedIn: true });
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

/**
 * 🔴 `effectiveBrowsingLevel` — THE PER-VIEWER NARROWING OF `maxBrowsingLevel`.
 *
 * `maxBrowsingLevel` is a property of the DOMAIN: every viewer on `civitai.red`
 * receives the identical, maximally-wide ceiling, so it cannot answer "may I
 * show THIS person mature content". `effectiveBrowsingLevel` is that ceiling
 * intersected with the viewer's own browsing level, computed at mint by
 * `resolveEffectiveBrowsingLevel` on top of `getServerBrowsingLevel`.
 *
 * The property under test is ONE-WAY: the projection may only ever NARROW. A
 * block must not be able to widen its own ceiling by reading this field, no
 * matter what the mint sends.
 *
 * 🔴 EVERY FIXTURE BELOW MAKES THE TWO INPUTS DISAGREE, AND IN BOTH DIRECTIONS.
 * A fixture where domain and viewer agree cannot distinguish "returns the
 * intersection" from "returns the domain ceiling" from "returns the viewer
 * level" — all three produce the same number — so an agreeing fixture would
 * pass against an implementation that ignores the viewer entirely. The bits
 * used are therefore chosen so the intersection differs from BOTH operands
 * wherever that is possible.
 *
 * PG=1 PG13=2 R=4 X=8 XXX=16 (`NsfwLevel`, mirrored in the SDK's
 * `BrowsingLevel`). SFW = PG|PG13 = 3, all = 31.
 */
describe('projectBlockInitMaturity — effectiveBrowsingLevel (per-viewer ceiling)', () => {
  it('🔴 a viewer WIDER than the domain cannot widen it: blue domain (SFW=3) + an R/X viewer (7) → 3', () => {
    // The real blue-domain footgun: `domainBrowsingCeiling('blue')` is SFW for
    // App Blocks while the viewer's saved level carries R. Projecting the raw
    // viewer level here would hand a publisher `7` — i.e. R — on a domain whose
    // whole point is that R is not allowed.
    const out = projectBlockInitMaturity({
      domain: 'blue',
      maxBrowsingLevel: 3, // PG | PG13
      effectiveBrowsingLevel: 7, // PG | PG13 | R  ← wider than the domain
    });
    expect(out.effectiveBrowsingLevel).toBe(3);
    // Not the raw viewer value, and specifically not carrying the R bit.
    expect(out.effectiveBrowsingLevel).not.toBe(7);
    expect((out.effectiveBrowsingLevel as number) & 4).toBe(0);
    // The domain ceiling itself is untouched by the narrowing.
    expect(out.maxBrowsingLevel).toBe(3);
  });

  it('🔴 a viewer NARROWER than the domain DOES narrow it: red domain (31) + a PG-only viewer (1) → 1', () => {
    // The direction the feature exists for. If the implementation returned the
    // domain ceiling (ignoring the viewer) this reads 31; if it returned the
    // viewer level unclamped it also reads 1 — which is why the widening case
    // above is the other half of the pair and both are required.
    const out = projectBlockInitMaturity({
      domain: 'red',
      maxBrowsingLevel: 31,
      effectiveBrowsingLevel: 1, // PG only
    });
    expect(out.effectiveBrowsingLevel).toBe(1);
    expect(out.maxBrowsingLevel).toBe(31);
  });

  it('🔴 intersects rather than picking a side: domain 11 (PG|PG13|X) ∩ viewer 22 (PG13|R|XXX) → 2', () => {
    // Chosen so the answer equals NEITHER operand: 11 & 22 = 2. An
    // implementation that returns `maxBrowsingLevel`, or `effectiveBrowsingLevel`,
    // or `Math.min` (→ 11), or a bitwise OR (→ 31) all fail here. The three
    // values are pairwise distinct and none is a multiple of another.
    const out = projectBlockInitMaturity({
      domain: 'red',
      maxBrowsingLevel: 11,
      effectiveBrowsingLevel: 22,
    });
    expect(out.effectiveBrowsingLevel).toBe(2);
  });

  it('is always a SUBSET of the projected domain ceiling, across the level lattice', () => {
    // Exhaustive over the 5-bit level space rather than a spot check: whatever
    // pair the mint sends, `effective & ~max` must be empty.
    for (let max = 0; max < 32; max++) {
      for (let eff = 0; eff < 32; eff++) {
        const { effectiveBrowsingLevel } = projectBlockInitMaturity({
          domain: 'red',
          maxBrowsingLevel: max,
          effectiveBrowsingLevel: eff,
        });
        expect(effectiveBrowsingLevel).not.toBeUndefined();
        expect((effectiveBrowsingLevel as number) & ~max).toBe(0);
      }
    }
  });

  it('omits the field when the mint did not send one (legacy server → pre-field behaviour)', () => {
    const out = projectBlockInitMaturity({ domain: 'red', maxBrowsingLevel: 31 });
    expect(out.effectiveBrowsingLevel).toBeUndefined();
    // The domain ceiling still ships, so an existing block is unaffected.
    expect(out.maxBrowsingLevel).toBe(31);
  });

  it('🔴 omits the field when there is NO projected ceiling to bound it against', () => {
    // Nothing would clamp the value here, so forwarding it on trust is the one
    // path by which a block could see a level the host never sanctioned.
    expect(
      projectBlockInitMaturity({ domain: 'green', effectiveBrowsingLevel: 31 })
        .effectiveBrowsingLevel
    ).toBeUndefined();
    // Same when the ceiling was PRESENT but junk — it is dropped upstream, so
    // there is still nothing to intersect with.
    expect(
      projectBlockInitMaturity({
        domain: 'green',
        maxBrowsingLevel: NaN,
        effectiveBrowsingLevel: 31,
      }).effectiveBrowsingLevel
    ).toBeUndefined();
  });

  it('fails closed on a malformed effective level (null / NaN / string)', () => {
    const base = { domain: 'red' as const, maxBrowsingLevel: 31 };
    expect(
      projectBlockInitMaturity({ ...base, effectiveBrowsingLevel: null }).effectiveBrowsingLevel
    ).toBeUndefined();
    expect(
      projectBlockInitMaturity({ ...base, effectiveBrowsingLevel: NaN }).effectiveBrowsingLevel
    ).toBeUndefined();
    expect(
      projectBlockInitMaturity({
        ...base,
        effectiveBrowsingLevel: '31' as unknown as number,
      }).effectiveBrowsingLevel
    ).toBeUndefined();
    expect(
      projectBlockInitMaturity({ ...base, effectiveBrowsingLevel: Infinity }).effectiveBrowsingLevel
    ).toBeUndefined();
  });

  it('🔴 rejects a NEGATIVE effective level instead of masking it (−1 & 31 === 31 — the widest viewer)', () => {
    // Two's complement has every high bit set, so masking junk would resolve to
    // the FULL domain ceiling — junk reading as the most permissive possible
    // viewer, which is the exact inversion this guard exists to prevent.
    const out = projectBlockInitMaturity({
      domain: 'red',
      maxBrowsingLevel: 31,
      effectiveBrowsingLevel: -1,
    });
    expect(out.effectiveBrowsingLevel).toBeUndefined();
    expect(out.effectiveBrowsingLevel).not.toBe(31);
  });

  it('projects an EMPTY effective level (0) as 0, not as absent', () => {
    // 0 is a real answer — "this viewer may be shown nothing here" — and is
    // falsy, so an `if (effective)` style implementation would drop it to
    // `undefined` and the SDK would then fall back to the WIDE domain ceiling.
    const out = projectBlockInitMaturity({
      domain: 'red',
      maxBrowsingLevel: 31,
      effectiveBrowsingLevel: 0,
    });
    expect(out.effectiveBrowsingLevel).toBe(0);
    expect(out.effectiveBrowsingLevel).not.toBeUndefined();
  });

  it('emits exactly the three maturity keys — the projection stays an allowlist', () => {
    expect(
      Object.keys(
        projectBlockInitMaturity({ domain: 'red', maxBrowsingLevel: 31, effectiveBrowsingLevel: 5 })
      ).sort()
    ).toEqual(['domain', 'effectiveBrowsingLevel', 'maxBrowsingLevel']);
  });
});
