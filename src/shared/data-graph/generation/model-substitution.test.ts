import { describe, expect, it, vi } from 'vitest';

import { ecosystems } from '~/shared/constants/basemodel.constants';
import { generationGraph } from './generation-graph';
import type { GenerationCtx } from './context';
import type { GateRule } from './gates';
import {
  createModelSubstitutionCollector,
  GENERATION_SURFACES,
  isGenerationSurface,
  isModelSubstitutionReason,
  MODEL_SUBSTITUTION_REASONS,
  type ModelSubstitution,
  type ModelSubstitutionCollector,
} from './model-substitution';
import {
  classifyModelSubstitutionReason,
  getWorkflowCapability,
  type WorkflowCapability,
} from './workflow-capability';
import { getWorkflowsForEcosystem } from './config/workflows';

/**
 * Silent checkpoint substitution — OBSERVABILITY, not behaviour (issue #3520,
 * phase 1).
 *
 * These tests drive the REAL `generationGraph.safeParse` (the exact validator
 * `validateInput` runs server-side) — nothing about the clamp, the classifier,
 * or the graph is mocked. Two things are being pinned:
 *
 *   1. The recording branch is REACHABLE and produces the right reason. A metric
 *      in a structurally unreachable branch is worse than none, so every reason
 *      is proven from a real parse rather than by calling the classifier alone.
 *   2. BEHAVIOUR IS UNCHANGED. Every substitution case asserts the model id the
 *      graph returns is byte-identical with and without a collector attached.
 *      Phase 1 must not alter which model runs.
 */

// A free user's server-shaped generation context, minus the collector. Same
// shape `buildGenerationContext` produces; hand-built so the test stays off
// sysRedis/DB.
function baseCtx(overrides?: Partial<GenerationCtx>): GenerationCtx {
  return {
    limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
    user: { isMember: false, tier: 'free' },
    flags: {},
    selfHostedDisabledEcosystems: [],
    selfHostedMode: 'enabled',
    gateRules: [],
    ...overrides,
  };
}

function ctxWithCollector(overrides?: Partial<GenerationCtx>): {
  ctx: GenerationCtx;
  collector: ModelSubstitutionCollector;
} {
  const collector = createModelSubstitutionCollector(classifyModelSubstitutionReason, 'block');
  return { ctx: { ...baseCtx(overrides), modelSubstitutions: collector }, collector };
}

function txt2imgInput(ecosystem: string, modelVersionId: number): Record<string, unknown> {
  return {
    workflow: 'txt2img',
    ecosystem,
    model: { id: modelVersionId },
    resources: [],
    prompt: 'a cat',
    sampler: 'Euler',
    steps: 25,
    quantity: 1,
    priority: 'low',
  };
}

/**
 * Run the REAL validator and read back the model id it settled on. `as never` on
 * the input mirrors every other graph test in the repo — `safeParse` is typed
 * against the per-ecosystem discriminated union, and these inputs are built
 * dynamically from the config rather than as narrowable literals.
 */
function parse(
  input: Record<string, unknown>,
  ctx: GenerationCtx
): { success: boolean; modelId: number | undefined } {
  const result = generationGraph.safeParse(input as never, ctx) as {
    success: boolean;
    data?: { model?: { id?: number } };
  };
  return { success: result.success, modelId: result.data?.model?.id };
}

// ── the reproduction from the issue's executed evidence table ────────────────
//
// Qwen is `modelLocked` with DISJOINT workflow-scoped version lists: 2558804 is
// an `img2img:edit` version, 2552908 is the `txt2img` default. Both ids are
// re-derived from the real config below so a config change fails loudly here
// rather than silently making these tests assert about ids that no longer exist.
const QWEN_TXT2IMG = getWorkflowCapability('Qwen', 'txt2img');
const QWEN_EDIT = getWorkflowCapability('Qwen', 'img2img:edit');

function versionIdsOf(cap: WorkflowCapability | undefined): number[] {
  const out: number[] = [];
  const walk = (group: NonNullable<WorkflowCapability['versions']>) => {
    for (const opt of group.options) {
      out.push(opt.value);
      if (opt.children) walk(opt.children);
    }
  };
  if (cap?.versions) walk(cap.versions);
  return out;
}

describe('Qwen fixtures are still what these tests assume', () => {
  it('Qwen/txt2img is modelLocked with a default, and Qwen/img2img:edit has a disjoint version', () => {
    expect(QWEN_TXT2IMG?.modelLocked).toBe(true);
    expect(typeof QWEN_TXT2IMG?.defaultModelId).toBe('number');
    const txt2imgIds = versionIdsOf(QWEN_TXT2IMG);
    const editOnly = versionIdsOf(QWEN_EDIT).filter((id) => !txt2imgIds.includes(id));
    expect(editOnly.length).toBeGreaterThan(0);
  });
});

const QWEN_DEFAULT = QWEN_TXT2IMG?.defaultModelId as number;
const QWEN_EDIT_ONLY = versionIdsOf(QWEN_EDIT).filter(
  (id) => !versionIdsOf(QWEN_TXT2IMG).includes(id)
)[0];
const QWEN_TXT2IMG_ALT = versionIdsOf(QWEN_TXT2IMG).filter((id) => id !== QWEN_DEFAULT)[0];
/** An id no ecosystem has ever heard of — the issue's `unrecognized` probe. */
const UNRECOGNIZED_ID = 987654321;

describe('records a silent substitution on the REAL graph path', () => {
  it("reason 'wrong-workflow' — an edit-only version sent to txt2img", () => {
    const { ctx, collector } = ctxWithCollector();
    const result = parse(txt2imgInput('Qwen', QWEN_EDIT_ONLY), ctx);

    expect(result.success).toBe(true);
    expect(result.modelId).toBe(QWEN_DEFAULT);
    expect(collector.list()).toEqual<ModelSubstitution[]>([
      {
        requested: QWEN_EDIT_ONLY,
        applied: QWEN_DEFAULT,
        reason: 'wrong-workflow',
        ecosystem: 'Qwen',
        workflow: 'txt2img',
      },
    ]);
  });

  it("reason 'unrecognized' — an id in no scoped list at all", () => {
    const { ctx, collector } = ctxWithCollector();
    const result = parse(txt2imgInput('Qwen', UNRECOGNIZED_ID), ctx);

    expect(result.success).toBe(true);
    expect(result.modelId).toBe(QWEN_DEFAULT);
    expect(collector.list()).toEqual<ModelSubstitution[]>([
      {
        requested: UNRECOGNIZED_ID,
        applied: QWEN_DEFAULT,
        reason: 'unrecognized',
        ecosystem: 'Qwen',
        workflow: 'txt2img',
      },
    ]);
  });

  it("reason 'gated' — the version IS offered for this workflow but a gate rule hides it", () => {
    // The clamp compares against the GATE-FILTERED visible list, so a rule that
    // hides an otherwise-valid txt2img version makes the clamp fire on an id the
    // config itself considers supported. That is neither of the two reasons the
    // issue names, and folding it into `unrecognized` would report an
    // entitlement decision as a retired model.
    const rule: GateRule = {
      id: 'test-gate',
      name: 'test',
      availableTo: 'moderators',
      presentation: 'hidden',
      ecosystems: [],
      workflows: [],
      modelVersionIds: [QWEN_TXT2IMG_ALT],
    };
    const { ctx, collector } = ctxWithCollector({ gateRules: [rule] });
    const result = parse(txt2imgInput('Qwen', QWEN_TXT2IMG_ALT), ctx);

    expect(result.success).toBe(true);
    expect(result.modelId).toBe(QWEN_DEFAULT);
    expect(collector.list()).toEqual<ModelSubstitution[]>([
      {
        requested: QWEN_TXT2IMG_ALT,
        applied: QWEN_DEFAULT,
        reason: 'gated',
        ecosystem: 'Qwen',
        workflow: 'txt2img',
      },
    ]);
  });

  // ── pass-through: no substitution, no record ──────────────────────────────
  it('records NOTHING when the requested version IS in the workflow list', () => {
    const { ctx, collector } = ctxWithCollector();
    const result = parse(txt2imgInput('Qwen', QWEN_TXT2IMG_ALT), ctx);

    expect(result.success).toBe(true);
    expect(result.modelId).toBe(QWEN_TXT2IMG_ALT);
    expect(collector.list()).toEqual([]);
  });

  it('records NOTHING when the requested version IS the workflow default', () => {
    const { ctx, collector } = ctxWithCollector();
    const result = parse(txt2imgInput('Qwen', QWEN_DEFAULT), ctx);

    expect(result.success).toBe(true);
    expect(result.modelId).toBe(QWEN_DEFAULT);
    expect(collector.list()).toEqual([]);
  });

  it('records NOTHING on a non-modelLocked ecosystem (the id passes through)', () => {
    const { ctx, collector } = ctxWithCollector();
    const result = parse(txt2imgInput('SDXL', UNRECOGNIZED_ID), ctx);

    expect(result.modelId).toBe(UNRECOGNIZED_ID);
    expect(collector.list()).toEqual([]);
  });
});

// ── 🔴 NO BEHAVIOUR CHANGE ──────────────────────────────────────────────────
//
// The headline risk of this PR is that observing the clamp perturbs it. Parse
// each case twice — once with a collector on the context, once without — and
// require the returned model id to be identical. The `without` run is exactly
// what `origin/main` does (a context with no `modelSubstitutions` field is the
// pre-change shape), so this is a direct before/after comparison.
describe('behaviour is unchanged by the recording', () => {
  it.each([
    ['wrong-workflow input', () => QWEN_EDIT_ONLY],
    ['unrecognized input', () => UNRECOGNIZED_ID],
    ['in-list input', () => QWEN_TXT2IMG_ALT],
    ['default input', () => QWEN_DEFAULT],
  ])('returns the same model id with and without a collector: %s', (_label, id) => {
    const withCollector = parse(txt2imgInput('Qwen', id()), ctxWithCollector().ctx);
    const without = parse(txt2imgInput('Qwen', id()), baseCtx());

    expect(without.success).toBe(withCollector.success);
    expect(withCollector.modelId).toBe(without.modelId);
    // Guard the guard: an `undefined === undefined` comparison would pass
    // vacuously if the parse stopped producing a model at all.
    expect(typeof without.modelId).toBe('number');
  });
});

// ── 🔴 IDEMPOTENCY ──────────────────────────────────────────────────────────
//
// A zod `.transform()` is not contractually single-shot, and a naive `push`
// would inflate the metric on any re-parse. MEASURED on the real path: the clamp
// runs EXACTLY ONCE per `generationGraph.safeParse` today (instrumented with a
// counter inside the clamp — 1 hit per parse, for both the wrong-workflow and
// unrecognized inputs). The dedupe is therefore the GUARANTEE, not the
// observation: this test re-parses the same context and requires the record
// count to stay at one, so a future zod/data-graph change that re-runs the
// transform cannot silently double-count.
describe('idempotency', () => {
  it('two parses on the SAME context produce exactly ONE record', () => {
    const { ctx, collector } = ctxWithCollector();
    parse(txt2imgInput('Qwen', QWEN_EDIT_ONLY), ctx);
    parse(txt2imgInput('Qwen', QWEN_EDIT_ONLY), ctx);
    expect(collector.list()).toHaveLength(1);
  });

  it('a DIFFERENT requested id on the same context is a separate record', () => {
    const { ctx, collector } = ctxWithCollector();
    parse(txt2imgInput('Qwen', QWEN_EDIT_ONLY), ctx);
    parse(txt2imgInput('Qwen', UNRECOGNIZED_ID), ctx);
    expect(collector.list().map((r) => r.requested)).toEqual([QWEN_EDIT_ONLY, UNRECOGNIZED_ID]);
  });

  it('takeUnemitted hands each record out once, so a double drain cannot double-count', () => {
    const { ctx, collector } = ctxWithCollector();
    parse(txt2imgInput('Qwen', QWEN_EDIT_ONLY), ctx);
    expect(collector.takeUnemitted()).toHaveLength(1);
    expect(collector.takeUnemitted()).toEqual([]);
    // …but `list()` is a read, not a drain — the snapshot still sees it.
    expect(collector.list()).toHaveLength(1);
  });
});

// ── 🔴 POPULATION: every modelLocked ecosystem reports ──────────────────────
//
// Derived from the real config at runtime (`getWorkflowCapability` reads the
// `model` node meta the form itself renders), NOT from the list in the issue.
// A NEW modelLocked ecosystem added later is picked up automatically and must
// report its substitution — it cannot silently inherit the unobservable
// behaviour this PR exists to close.
describe('every modelLocked (ecosystem, workflow) pair records its substitution', () => {
  const lockedPairs: Array<{ ecosystem: string; workflow: string; defaultModelId: number }> = [];
  for (const eco of ecosystems) {
    for (const option of getWorkflowsForEcosystem(eco.id)) {
      const cap = getWorkflowCapability(eco.key, option.graphKey);
      if (!cap?.modelLocked || !cap.defaultModelId) continue;
      lockedPairs.push({
        ecosystem: eco.key,
        workflow: option.graphKey,
        defaultModelId: cap.defaultModelId,
      });
    }
  }

  it('the enumeration is non-empty (guard the guard)', () => {
    // Without this an empty sweep would make the per-pair assertion below pass
    // vacuously.
    //
    // MEASURED at the time of writing: 89 (ecosystem, workflow) pairs across 43
    // ecosystems. That is much wider than the ~23 IMAGE ecosystems the issue
    // enumerates, because the enumeration here is derived from live config and
    // covers video/audio ecosystems and per-workflow variants too — which is
    // exactly the point of deriving it rather than transcribing the list. A
    // FLOOR, not the exact count, so adding an ecosystem doesn't fail this line
    // spuriously; the per-pair assertion below is what actually has to hold.
    expect(lockedPairs.length).toBeGreaterThanOrEqual(23);
  });

  it('records a substitution for an unrecognized id on EVERY locked pair', () => {
    const silent: string[] = [];
    for (const pair of lockedPairs) {
      const { ctx, collector } = ctxWithCollector();
      // The parse may FAIL for unrelated reasons on some workflows (a missing
      // source image, a video field, …). That is fine and deliberate: the clamp
      // runs during input parsing regardless, and `validateInput` emits
      // regardless of `result.success` — a parse that substituted and then
      // failed elsewhere still substituted.
      parse({ ...txt2imgInput(pair.ecosystem, UNRECOGNIZED_ID), workflow: pair.workflow }, ctx);
      const records = collector.list();
      const ok =
        records.length === 1 &&
        records[0].requested === UNRECOGNIZED_ID &&
        records[0].applied === pair.defaultModelId &&
        records[0].reason === 'unrecognized';
      if (!ok) silent.push(`${pair.ecosystem}/${pair.workflow} -> ${JSON.stringify(records)}`);
    }
    expect(silent).toEqual([]);
  });
});

// ── collector unit behaviour ────────────────────────────────────────────────
describe('createModelSubstitutionCollector', () => {
  const event = { requested: 1, applied: 2, ecosystem: 'Qwen', workflow: 'txt2img' };

  it('classifies via the injected classifier', () => {
    const classify = vi.fn().mockReturnValue('unrecognized' as const);
    const collector = createModelSubstitutionCollector(classify, 'block');
    collector.record(event);
    expect(classify).toHaveBeenCalledWith(event);
    expect(collector.list()).toEqual([{ ...event, reason: 'unrecognized' }]);
  });

  it('SWALLOWS a throwing classifier — observability must not break a parse', () => {
    const collector = createModelSubstitutionCollector(() => {
      throw new Error('boom');
    }, 'block');
    expect(() => collector.record(event)).not.toThrow();
    expect(collector.list()).toEqual([]);
  });

  it('list() returns a copy — a caller cannot mutate the collector', () => {
    const collector = createModelSubstitutionCollector(() => 'unrecognized', 'block');
    collector.record(event);
    collector.list().push({ ...event, reason: 'gated' });
    expect(collector.list()).toHaveLength(1);
  });

  it('two collectors do not share state (per-request isolation)', () => {
    const a = createModelSubstitutionCollector(() => 'unrecognized', 'block');
    const b = createModelSubstitutionCollector(() => 'unrecognized', 'onsite');
    a.record(event);
    expect(b.list()).toEqual([]);
  });

  it('carries the SURFACE it was constructed with', () => {
    // The surface is fixed by whoever built the request context; `validateInput`
    // (where the metric is emitted) is shared by every surface and cannot infer
    // it. Pinning it here is what makes the emitter's label attributable.
    expect(createModelSubstitutionCollector(() => 'unrecognized', 'block').surface).toBe('block');
    expect(createModelSubstitutionCollector(() => 'unrecognized', 'onsite').surface).toBe('onsite');
    expect(createModelSubstitutionCollector(() => 'unrecognized', 'preset').surface).toBe('preset');
  });

  // ── 🔴 a classifier that THROWS must not permanently drop the key ──────────
  //
  // `seen` is the write-once dedupe. Marking the key BEFORE calling `classify`
  // meant a classifier that threw on its first call lost that substitution for
  // the entire request: the throw was swallowed, nothing was pushed, and every
  // later attempt short-circuited on `seen.has(key)`. Harmless with today's pure
  // classifier — and exactly the kind of "only under a fault" data loss that is
  // invisible until the fault happens.
  it('a classifier that throws ONCE does not permanently drop the key', () => {
    let calls = 0;
    const collector = createModelSubstitutionCollector(() => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return 'unrecognized';
    }, 'block');

    collector.record(event);
    expect(collector.list()).toEqual([]); // the throw was swallowed

    // Same key again — must be RE-ATTEMPTED, not short-circuited by `seen`.
    collector.record(event);
    expect(calls).toBe(2);
    expect(collector.list()).toEqual([{ ...event, reason: 'unrecognized' }]);
  });

  it('an always-throwing classifier still leaves the key retryable', () => {
    let calls = 0;
    const collector = createModelSubstitutionCollector(() => {
      calls += 1;
      throw new Error('boom');
    }, 'block');
    collector.record(event);
    collector.record(event);
    expect(calls).toBe(2);
    expect(collector.list()).toEqual([]);
  });

  // ── 🔴 a bogus classifier return cannot reach the wire or the metric ───────
  //
  // `ModelSubstitutionReason` is erased at runtime, so the "3 values forever"
  // guarantee has to be enforced in code. A classifier returning `undefined` (a
  // refactor that forgets a branch, a stub, a `.js` caller) would otherwise put
  // `reason: undefined` on the public snapshot AND into `inc({ reason })`, which
  // is how a bounded label set stops being bounded.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an unknown string', 'not-a-reason'],
    ['a number', 7],
    ['an object', { reason: 'unrecognized' }],
  ])('DROPS a classifier return that is %s', (_label, bogus) => {
    const collector = createModelSubstitutionCollector(
      () => bogus as never as (typeof MODEL_SUBSTITUTION_REASONS)[number],
      'block'
    );
    collector.record(event);
    expect(collector.list()).toEqual([]);
    expect(collector.takeUnemitted()).toEqual([]);
  });

  it('records every reason the code-owned union declares (guard the guard)', () => {
    // Without this, the drop-test above would also pass if `record` dropped
    // EVERYTHING — a guard that rejects the whole population is not a guard.
    for (const reason of MODEL_SUBSTITUTION_REASONS) {
      const collector = createModelSubstitutionCollector(() => reason, 'block');
      collector.record(event);
      expect(collector.list()).toEqual([{ ...event, reason }]);
    }
  });
});

describe('runtime narrowing helpers', () => {
  it('isModelSubstitutionReason accepts exactly the declared union', () => {
    for (const reason of MODEL_SUBSTITUTION_REASONS) {
      expect(isModelSubstitutionReason(reason)).toBe(true);
    }
    for (const bogus of [undefined, null, '', 'gated ', 'GATED', 7, {}, []]) {
      expect(isModelSubstitutionReason(bogus)).toBe(false);
    }
  });

  it('isGenerationSurface accepts exactly the declared union', () => {
    for (const surface of GENERATION_SURFACES) {
      expect(isGenerationSurface(surface)).toBe(true);
    }
    for (const bogus of [undefined, null, '', 'blocks', 'Onsite', 7, {}, []]) {
      expect(isGenerationSurface(bogus)).toBe(false);
    }
  });

  it('the surface union is exactly the three wired call sites', () => {
    // 3 reasons x 3 surfaces = 9 series. Adding a value here is a deliberate,
    // reviewable widening of the counter's cardinality, so it has to fail a test
    // rather than land silently.
    expect([...GENERATION_SURFACES]).toEqual(['block', 'onsite', 'preset']);
    expect([...MODEL_SUBSTITUTION_REASONS]).toEqual(['wrong-workflow', 'unrecognized', 'gated']);
  });
});

// ── classifier ──────────────────────────────────────────────────────────────
describe('classifyModelSubstitutionReason', () => {
  it('reuses resolveVersionWorkflowScope in BOTH directions (not just txt2img)', () => {
    // The reverse direction — a txt2img-only version sent WITH a source image —
    // is the case the narrower `assertCheckpointVersionSupportsWorkflow` guard
    // deliberately left open. The resolver was always direction-agnostic; this
    // pins that the classifier uses it that way.
    expect(
      classifyModelSubstitutionReason({
        requested: QWEN_DEFAULT,
        applied: QWEN_EDIT_ONLY,
        ecosystem: 'Qwen',
        workflow: 'img2img:edit',
      })
    ).toBe('wrong-workflow');
  });

  it('falls back to unrecognized for an ecosystem key the config does not know', () => {
    expect(
      classifyModelSubstitutionReason({
        requested: UNRECOGNIZED_ID,
        applied: 1,
        ecosystem: 'NotAnEcosystem',
        workflow: 'txt2img',
      })
    ).toBe('unrecognized');
  });
});
