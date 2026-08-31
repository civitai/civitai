import { describe, expect, it } from 'vitest';

import { ecosystems } from '~/shared/constants/basemodel.constants';
import { generationGraph } from './generation-graph';
import type { GenerationCtx } from './context';
import {
  createModelSubstitutionCollector,
  type ModelSubstitutionClassifier,
} from './model-substitution';
import { classifyModelSubstitutionReason, getWorkflowCapability } from './workflow-capability';
import { getWorkflowsForEcosystem } from './config/workflows';

/**
 * 🔴 THE HARD CONSTRAINT OF #3520 PHASE 1, CHECKED OVER THE WHOLE POPULATION.
 *
 * Phase 1 is RECORD-ONLY: which model runs, whether the parse succeeds, and what
 * it returns must be byte-identical to a run with no collector attached — because
 * a context with no `modelSubstitutions` field IS the pre-change shape, so
 * "without" is a direct before/after comparison rather than a proxy for one.
 *
 * The companion tests in `model-substitution.test.ts` check FOUR hand-picked
 * Qwen cases and only the resulting `model.id`. This file exists because that is
 * a sample and a projection: it can neither see a perturbation on some other
 * ecosystem, nor one on a field other than the model id (a changed error set, a
 * dropped computed key, a different `success`). So this compares the FULL parse
 * result — serialized, in full — across EVERY (ecosystem, workflow) pair the
 * config offers.
 *
 * Two adversarial conditions are covered:
 *
 *   1. The real classifier, over every pair. This is the ordinary path.
 *   2. A classifier that THROWS ON EVERY CALL, over every modelLocked pair. The
 *      collector swallows classifier faults by contract; this proves the swallow
 *      also leaves the PARSE untouched, i.e. that a broken observability
 *      dependency cannot change a generation. (It is also the condition under
 *      which the write-once `seen` bookkeeping is most likely to diverge —
 *      nothing is ever recorded, so every clamp hit re-attempts.)
 *
 * COST: ~4 parses per pair. The whole file runs in a couple of seconds.
 */

function baseCtx(): GenerationCtx {
  return {
    limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
    user: { isMember: false, tier: 'free' },
    flags: {},
    selfHostedDisabledEcosystems: [],
    selfHostedMode: 'enabled',
    gateRules: [],
  };
}

/** An id no ecosystem has ever heard of — forces the clamp on every locked pair. */
const UNRECOGNIZED_ID = 987654321;

/**
 * Serialize the ENTIRE parse result, not just `data.model.id`. `JSON.stringify`
 * with sorted keys so a key-ordering difference cannot masquerade as a value
 * difference (or hide one). `undefined` is stringified explicitly so a field
 * that disappears is not silently equal to one that was never there.
 */
function serializeResult(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (v: unknown): unknown => {
    if (v === undefined) return '__undefined__';
    if (v === null || typeof v !== 'object') {
      return typeof v === 'function' ? '__function__' : v;
    }
    if (seen.has(v as object)) return '__circular__';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(normalize);
    if (v instanceof Error) return { __error__: v.message };
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = normalize((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
}

function parseFull(input: Record<string, unknown>, ctx: GenerationCtx): string {
  return serializeResult(generationGraph.safeParse(input as never, ctx));
}

function inputFor(ecosystem: string, workflow: string, modelVersionId: number) {
  return {
    workflow,
    ecosystem,
    model: { id: modelVersionId },
    resources: [],
    prompt: 'a cat',
    sampler: 'Euler',
    steps: 25,
    quantity: 1,
    priority: 'low' as const,
  };
}

type Pair = { ecosystem: string; workflow: string; locked: boolean; defaultModelId?: number };

const ALL_PAIRS: Pair[] = [];
for (const eco of ecosystems) {
  for (const option of getWorkflowsForEcosystem(eco.id)) {
    const cap = getWorkflowCapability(eco.key, option.graphKey);
    ALL_PAIRS.push({
      ecosystem: eco.key,
      workflow: option.graphKey,
      locked: !!cap?.modelLocked && !!cap?.defaultModelId,
      defaultModelId: cap?.defaultModelId,
    });
  }
}
const LOCKED_PAIRS = ALL_PAIRS.filter((p) => p.locked);

/** The probe ids each pair is exercised with. */
function probeIdsFor(pair: Pair): number[] {
  // The unrecognized id forces the clamp everywhere it can fire; the pair's own
  // default is the pass-through control (no substitution → the collector must
  // still be inert).
  return pair.defaultModelId ? [UNRECOGNIZED_ID, pair.defaultModelId] : [UNRECOGNIZED_ID];
}

const THROWING_CLASSIFIER: ModelSubstitutionClassifier = () => {
  throw new Error('classifier is down');
};

describe('#3520 phase 1 changes NO behaviour, over the FULL (ecosystem, workflow) population', () => {
  it('the population is non-empty and contains locked pairs (guard the guard)', () => {
    // Without this, every sweep below would pass vacuously over an empty list —
    // and a "zero diffs" result would mean nothing was compared.
    expect(ALL_PAIRS.length).toBeGreaterThanOrEqual(100);
    expect(LOCKED_PAIRS.length).toBeGreaterThanOrEqual(23);
  });

  it('the FULL parse result is identical with and without a collector, on every pair', () => {
    const diffs: string[] = [];
    let compared = 0;
    for (const pair of ALL_PAIRS) {
      for (const id of probeIdsFor(pair)) {
        const input = inputFor(pair.ecosystem, pair.workflow, id);
        const withCollector = parseFull(input, {
          ...baseCtx(),
          modelSubstitutions: createModelSubstitutionCollector(
            classifyModelSubstitutionReason,
            'block'
          ),
        });
        // No `modelSubstitutions` field at all == the pre-change context shape.
        const without = parseFull(input, baseCtx());
        compared += 1;
        if (withCollector !== without) {
          diffs.push(`${pair.ecosystem}/${pair.workflow}#${id}`);
        }
      }
    }
    expect(compared).toBeGreaterThanOrEqual(ALL_PAIRS.length);
    expect(diffs).toEqual([]);
  });

  it('…and identical with a classifier that THROWS on every call, on every locked pair', () => {
    const diffs: string[] = [];
    let compared = 0;
    for (const pair of LOCKED_PAIRS) {
      for (const id of probeIdsFor(pair)) {
        const input = inputFor(pair.ecosystem, pair.workflow, id);
        const collector = createModelSubstitutionCollector(THROWING_CLASSIFIER, 'block');
        const withBroken = parseFull(input, { ...baseCtx(), modelSubstitutions: collector });
        const without = parseFull(input, baseCtx());
        compared += 1;
        if (withBroken !== without) diffs.push(`${pair.ecosystem}/${pair.workflow}#${id}`);
        // The throw really was swallowed, and nothing was recorded.
        expect(collector.list()).toEqual([]);
      }
    }
    expect(compared).toBeGreaterThanOrEqual(LOCKED_PAIRS.length);
    expect(diffs).toEqual([]);
  });

  it('…and identical with a classifier that returns a BOGUS reason', () => {
    // The runtime narrowing drops such a record. That drop must also be inert
    // with respect to the parse.
    const diffs: string[] = [];
    for (const pair of LOCKED_PAIRS) {
      const input = inputFor(pair.ecosystem, pair.workflow, UNRECOGNIZED_ID);
      const collector = createModelSubstitutionCollector(
        (() => undefined) as unknown as ModelSubstitutionClassifier,
        'block'
      );
      const withBogus = parseFull(input, { ...baseCtx(), modelSubstitutions: collector });
      const without = parseFull(input, baseCtx());
      if (withBogus !== without) diffs.push(`${pair.ecosystem}/${pair.workflow}`);
      expect(collector.list()).toEqual([]);
    }
    expect(diffs).toEqual([]);
  });

  it('the comparison can actually SEE a difference (negative control)', () => {
    // 🔴 A "zero diffs" result is worthless if the comparator is blind. Two
    // parses that genuinely differ must compare unequal, or every sweep above is
    // a green light from an instrument that reads zero no matter what.
    const locked = LOCKED_PAIRS[0];
    const a = parseFull(inputFor(locked.ecosystem, locked.workflow, UNRECOGNIZED_ID), baseCtx());
    const b = parseFull(
      { ...inputFor(locked.ecosystem, locked.workflow, UNRECOGNIZED_ID), prompt: 'a dog' },
      baseCtx()
    );
    expect(a).not.toEqual(b);
  });
});
