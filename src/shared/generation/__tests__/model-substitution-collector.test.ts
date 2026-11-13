import { describe, expect, it, vi } from 'vitest';

import {
  createModelSubstitutionCollector,
  MODEL_SUBSTITUTION_REASONS,
} from '~/shared/generation/model-substitution';
import {
  classifyModelSubstitutionReason,
  getWorkflowCapability,
  type WorkflowCapability,
} from '~/shared/generation/workflow-capability';

/**
 * The collector and the classifier, which outlived the lane their tests lived under.
 *
 * These cases came from `src/shared/data-graph/generation/model-substitution.test.ts`. That
 * file was deleted with the data-graph lane, but most of it tested
 * `~/shared/generation/model-substitution` — a module that is still here and still feeds the
 * prom emitter and the App Blocks wire. It was deleted for where it lived, not for what it
 * tested. The graph-path half genuinely went with the lane; the properties below have no
 * other home in the tree:
 *
 *   · per-request isolation, which the module's own docblock names as the cross-user leak
 *   · the reason-narrowing inside `record()` — the metrics layer's narrowing is tested, but
 *     `projectModelSubstitutions` feeds `BlockWorkflowSnapshot.modelSubstitutions[].reason`
 *     WITHOUT passing through it, so this is the public wire contract's only guard
 *   · `seen.add` landing after a successful push, so a classifier that throws once does not
 *     silently drop that substitution for the rest of the request
 *   · `list()` handing out a copy
 *   · the classifier's `unrecognized` fallback, and that it reads the scope resolver in both
 *     directions rather than assuming txt2img
 */

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

const QWEN_DEFAULT = QWEN_TXT2IMG?.defaultModelId as number;
const QWEN_EDIT_ONLY = versionIdsOf(QWEN_EDIT).filter(
  (id) => !versionIdsOf(QWEN_TXT2IMG).includes(id)
)[0] as number;
const UNRECOGNIZED_ID = 987654321;

// The two classifier cases below are only meaningful if the fixtures still have the shape
// they assume — a modelLocked txt2img with a default, and an edit-only version disjoint
// from it. A Qwen config change otherwise turns them green over nothing.
describe('Qwen fixtures are still what these tests assume', () => {
  it('txt2img is modelLocked with a default, and img2img:edit has a disjoint version', () => {
    expect(QWEN_TXT2IMG?.modelLocked).toBe(true);
    expect(typeof QWEN_DEFAULT).toBe('number');
    expect(typeof QWEN_EDIT_ONLY).toBe('number');
  });
});

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

  // The module docblock names this as the cross-user leak: a mutable array behind one of
  // these would accumulate substitutions ACROSS USERS and then report one user's requested
  // model id to another. Hoisting `records`/`seen` to module scope passes everything else.
  it('two collectors do not share state (per-request isolation)', () => {
    const a = createModelSubstitutionCollector(() => 'unrecognized', 'block');
    const b = createModelSubstitutionCollector(() => 'unrecognized', 'onsite');
    a.record(event);
    expect(b.list()).toEqual([]);
  });

  // ── 🔴 a classifier that THROWS must not permanently drop the key ──────────
  //
  // `seen` is the write-once dedupe. Marking the key BEFORE calling `classify` meant a
  // classifier that threw on its first call lost that substitution for the entire request:
  // the throw was swallowed, nothing was pushed, and every later attempt short-circuited on
  // `seen.has(key)`. Harmless with today's pure classifier — and exactly the kind of "only
  // under a fault" data loss that is invisible until the fault happens.
  it('a classifier that throws ONCE does not permanently drop the key', () => {
    let calls = 0;
    const collector = createModelSubstitutionCollector(() => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return 'unrecognized';
    }, 'block');

    collector.record(event);
    expect(collector.list()).toEqual([]);

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
  // `ModelSubstitutionReason` is erased at runtime, so the bounded-reason guarantee has to
  // be enforced in code. A classifier returning `undefined` (a refactor that forgets a
  // branch, a stub, a `.js` caller) would otherwise put `reason: undefined` on the public
  // snapshot AND into `inc({ reason })`, which is how a bounded label set stops being
  // bounded.
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
    // Without this, the drop-test above would also pass if `record` dropped EVERYTHING — a
    // guard that rejects the whole population is not a guard.
    for (const reason of MODEL_SUBSTITUTION_REASONS) {
      const collector = createModelSubstitutionCollector(() => reason, 'block');
      collector.record(event);
      expect(collector.list()).toEqual([{ ...event, reason }]);
    }
  });
});

describe('classifyModelSubstitutionReason', () => {
  it('reuses resolveVersionWorkflowScope in BOTH directions (not just txt2img)', () => {
    // The reverse direction — a txt2img-only version sent WITH a source image — is the case
    // the narrower `assertCheckpointVersionSupportsWorkflow` guard deliberately left open.
    // The resolver was always direction-agnostic; this pins that the classifier uses it so.
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
