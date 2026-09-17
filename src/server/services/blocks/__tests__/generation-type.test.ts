import { describe, expect, it } from 'vitest';

import {
  BLOCK_GENERATION_TYPES,
  BLOCK_WORKFLOW_KIND_GENERATION_TYPES,
  isBlockGenerationType,
  resolveBlockGenerationType,
} from '../generation-type';
import { getStep, listRegisteredSteps, REGISTERED_STEP_IDS } from '../steps';

/**
 * App Blocks GENERATION TYPE resolution — the app-facing key persisted on
 * `block_spend_attribution.generation_type`.
 *
 * NOTE ON WHAT THESE ARE. This module is new, so these are FIRST-PARTY UNIT
 * TESTS, not regression coverage — there is no prior behaviour they could have
 * caught. The regression assertions (the spend row actually carrying the key,
 * from each of the three submit paths) live in
 * `spend-attribution.service.test.ts` and `blocks.router.workflow.test.ts`, and
 * those DO fail on the pre-change tree.
 *
 * Expected values are pinned as LITERALS throughout — never re-derived from the
 * function under test, and never from the registry entry the assertion is about.
 */

describe('resolveBlockGenerationType — the two non-registry kinds', () => {
  it('resolves kind textToImage to the literal key "textToImage"', () => {
    expect(resolveBlockGenerationType({ kind: 'textToImage', modelId: 7 })).toBe('textToImage');
  });

  it('resolves kind customComfy (recipe arm) to the literal key "customComfy"', () => {
    expect(
      resolveBlockGenerationType({ kind: 'customComfy', recipe: 'seamless-pano-360', params: {} })
    ).toBe('customComfy');
  });

  it('resolves kind customComfy (INLINE arm) to the same key — no per-arm branch', () => {
    // The inline arm is a nested discriminated union on `mode`; both arms share
    // `kind: 'customComfy'`, so both must produce the same generation type.
    expect(
      resolveBlockGenerationType({
        kind: 'customComfy',
        mode: 'inline',
        workflow: {},
        params: {},
      })
    ).toBe('customComfy');
  });
});

describe('resolveBlockGenerationType — kind: step resolves to the STEP ID, not the orchestrator type', () => {
  // 🔴 THE DESIGN RISK THIS PR IS MOST LIKELY TO GET BACKWARDS, pinned with
  // literals on BOTH sides: the value written is the registry id (a permanent
  // public wire commitment), and it is specifically NOT the entry's
  // `orchestratorType` (the orchestrator's internal spelling, free to change).
  it('resolves convert-image to "convert-image" and NOT "convertImage"', () => {
    const resolved = resolveBlockGenerationType({
      kind: 'step',
      step: 'convert-image',
      params: {},
    });
    expect(resolved).toBe('convert-image');
    expect(resolved).not.toBe('convertImage');
  });

  it('resolves chat-completion to "chat-completion" and NOT "chatCompletion"', () => {
    const resolved = resolveBlockGenerationType({
      kind: 'step',
      step: 'chat-completion',
      params: {},
    });
    expect(resolved).toBe('chat-completion');
    expect(resolved).not.toBe('chatCompletion');
  });

  it('the two spellings really are different for every registered step — otherwise the two assertions above are vacuous', () => {
    // Guards the guards. If some entry ever declared `orchestratorType` equal to
    // its registry id, the `not.toBe` assertions above would pass for free and
    // stop discriminating. Enumerates the REAL population rather than a list.
    const pairs = listRegisteredSteps().map(([id, step]) => [id, step.orchestratorType]);
    expect(pairs.length).toBeGreaterThan(0);
    for (const [id, orchestratorType] of pairs) {
      expect(id).not.toBe(orchestratorType);
    }
    // And the orchestrator spelling is never itself an accepted value.
    for (const [, orchestratorType] of pairs) {
      expect(isBlockGenerationType(orchestratorType)).toBe(false);
    }
  });

  it('rejects an UNREGISTERED step id — null, not the raw string', () => {
    expect(
      resolveBlockGenerationType({ kind: 'step', step: 'not-a-real-step', params: {} })
    ).toBeNull();
  });

  it('rejects a prototype key as a step id (the dispatch-table fail-open trap)', () => {
    // `getStep` indexes a plain object literal, so a prototype key is TRUTHY
    // there — a `getStep(x) ? x : null` guard would let it through and stamp it
    // on a money row. The resolver must not be built that way.
    expect(getStep('toString')).toBeTruthy(); // the hazard is real, not hypothetical
    expect(resolveBlockGenerationType({ kind: 'step', step: 'toString', params: {} })).toBeNull();
    expect(
      resolveBlockGenerationType({ kind: 'step', step: 'constructor', params: {} })
    ).toBeNull();
  });

  it('does not let a kind key masquerade as a step id', () => {
    // `{ kind: 'step', step: 'textToImage' }` must not report an image
    // generation. The wire schema rejects this body; a wrong value here would be
    // worse than a null one, so the resolver checks the step arm against the
    // step ids only.
    expect(
      resolveBlockGenerationType({ kind: 'step', step: 'textToImage', params: {} })
    ).toBeNull();
  });
});

describe('resolveBlockGenerationType — unresolvable input degrades to NULL and never throws', () => {
  // The spend path is fire-and-forget and fail-open. Resolution must not become
  // a new way to throw on it, so every junk shape returns null rather than
  // raising. Each case is asserted to both NOT throw and to be null.
  const junk: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'textToImage'],
    ['a number', 42],
    ['an array', ['textToImage']],
    ['an empty object', {}],
    ['an unknown kind', { kind: 'videoToVideo', params: {} }],
    ['a non-string kind', { kind: 7 }],
    ['kind step with no step key', { kind: 'step', params: {} }],
    ['kind step with a non-string step', { kind: 'step', step: 7, params: {} }],
    ['kind step with a null step', { kind: 'step', step: null, params: {} }],
    ['an object with a null prototype', Object.create(null)],
  ];

  for (const [label, input] of junk) {
    it(`returns null for ${label}`, () => {
      expect(() => resolveBlockGenerationType(input)).not.toThrow();
      expect(resolveBlockGenerationType(input)).toBeNull();
    });
  }
});

describe('isBlockGenerationType', () => {
  it('accepts the two kinds and every registered step id — literal expectations', () => {
    expect(isBlockGenerationType('textToImage')).toBe(true);
    expect(isBlockGenerationType('customComfy')).toBe(true);
    expect(isBlockGenerationType('convert-image')).toBe(true);
    expect(isBlockGenerationType('chat-completion')).toBe(true);
  });

  it('rejects orchestrator spellings, near-misses and non-strings', () => {
    expect(isBlockGenerationType('convertImage')).toBe(false);
    expect(isBlockGenerationType('chatCompletion')).toBe(false);
    expect(isBlockGenerationType('step')).toBe(false);
    expect(isBlockGenerationType('texttoimage')).toBe(false); // case-sensitive
    expect(isBlockGenerationType('')).toBe(false);
    expect(isBlockGenerationType(undefined)).toBe(false);
    expect(isBlockGenerationType(null)).toBe(false);
    expect(isBlockGenerationType(7)).toBe(false);
  });

  it('rejects prototype keys', () => {
    expect(isBlockGenerationType('toString')).toBe(false);
    expect(isBlockGenerationType('constructor')).toBe(false);
    expect(isBlockGenerationType('__proto__')).toBe(false);
  });
});

describe('BLOCK_GENERATION_TYPES stays DERIVED from the registry', () => {
  // Structural ledger: the accepted set is exactly the two kinds plus whatever
  // the registry holds. Fails if the list is ever hand-maintained and drifts —
  // in EITHER direction (a step registered but not accepted, or an extra value
  // accepted that no longer corresponds to anything).
  it('is exactly the two kinds plus every registered step id', () => {
    expect([...BLOCK_GENERATION_TYPES].sort()).toEqual(
      ['textToImage', 'customComfy', ...REGISTERED_STEP_IDS].sort()
    );
  });

  it('every registered step id resolves through the kind:step path', () => {
    for (const id of REGISTERED_STEP_IDS) {
      expect(resolveBlockGenerationType({ kind: 'step', step: id, params: {} })).toBe(id);
    }
  });

  it('INVARIANT GUARD (not regression coverage): no registered step id collides with a kind key', () => {
    // Labelled as an invariant guard because nothing has ever violated it — it
    // would have passed before this change too. It exists because the ONE-COLUMN
    // design rests on it: a step id implies `kind: 'step'` only while the two
    // name spaces stay disjoint, and the registry's own load-time invariants do
    // not know these two strings exist. A step registered as `textToImage` would
    // make the column ambiguous; this turns that into a red test rather than a
    // silently ambiguous column.
    for (const id of REGISTERED_STEP_IDS) {
      expect(BLOCK_WORKFLOW_KIND_GENERATION_TYPES as readonly string[]).not.toContain(id);
    }
  });
});
