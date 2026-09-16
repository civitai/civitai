import { describe, expect, it } from 'vitest';
import {
  PLATFORM_INTERNAL_STEP_TYPES,
  PlatformInternalStepTypeError,
  assertStepTypeAllowed,
  isPlatformInternalStepType,
} from '~/server/services/blocks/steps/orchestrator-denylist';
import { assertStepInvariants, listRegisteredSteps } from '~/server/services/blocks/steps';

/**
 * 🔴 EVERY ASSERTION HERE NAMES `PlatformInternalStepTypeError` SPECIFICALLY.
 *
 * That is the whole design of this file. `assertStepInvariants` has a dozen
 * clauses that throw plain `Error`s, and the wire schema rejects unknown step
 * ids on its own. A test that only asserted "it threw" would stay green after
 * the denylist clause was deleted, because a neighbouring guard would kill the
 * same input for a different reason — the classic mutation-dies-for-the-wrong-
 * reason failure. Asserting the error TYPE (and, where it matters, the offending
 * `$type` it carries) is what makes the mutation observable.
 */
describe('orchestrator denylist — the predicate', () => {
  it('refuses a scanner, and the refusal is attributable to the denylist', () => {
    expect(() => assertStepTypeAllowed('modelPickleScan')).toThrow(PlatformInternalStepTypeError);
    // The error names WHICH type, so an operator reading a log learns the cause.
    try {
      assertStepTypeAllowed('modelPickleScan');
      expect.unreachable('assertStepTypeAllowed must throw for a denylisted type');
    } catch (e) {
      expect(e).toBeInstanceOf(PlatformInternalStepTypeError);
      expect((e as PlatformInternalStepTypeError).stepType).toBe('modelPickleScan');
    }
  });

  it('refuses a moderation classifier', () => {
    expect(() => assertStepTypeAllowed('xGuardModeration')).toThrow(PlatformInternalStepTypeError);
  });

  it('prefixes the caller-supplied context when given one', () => {
    expect(() => assertStepTypeAllowed('modelHash', "block step 'x'")).toThrow(
      /block step 'x': orchestrator step type 'modelHash' is platform-internal/
    );
  });

  /**
   * 🔴 THE OPERATOR DECISION, PINNED AS A TEST.
   *
   * `training` was moved OUT of the platform-internal set by an explicit
   * operator decision that REVERSED an earlier classification. It is the entry a
   * future reader is most likely to "fix" back, so it is asserted rather than
   * left to a comment. Same for `chatCompletion`, which is already registered.
   */
  it('ALLOWS training and chatCompletion — an explicit operator decision', () => {
    expect(() => assertStepTypeAllowed('training')).not.toThrow();
    expect(() => assertStepTypeAllowed('imageResourceTraining')).not.toThrow();
    expect(() => assertStepTypeAllowed('chatCompletion')).not.toThrow();
    expect(isPlatformInternalStepType('training')).toBe(false);
    expect(isPlatformInternalStepType('chatCompletion')).toBe(false);
  });

  it('allows an ordinary generation type', () => {
    expect(() => assertStepTypeAllowed('textToImage')).not.toThrow();
    expect(() => assertStepTypeAllowed('videoGen')).not.toThrow();
  });

  /**
   * A denylist ALLOWS anything it has not heard of — that is the accepted trade
   * of the no-allowlist direction, and pinning it stops someone reading the set
   * as exhaustive.
   */
  it('allows an unknown//future $type by construction', () => {
    expect(() => assertStepTypeAllowed('somethingInventedUpstreamTomorrow')).not.toThrow();
  });

  /**
   * 🔴 THE RETRACTION, PINNED — these three were DENIED in an earlier draft on a
   * "moderation oracle" argument that did not survive audit, and this test is
   * what stops them drifting back in. The reasons are in the module docblock;
   * the sharp one is that denying `ageClassification` stopped an app checking
   * whether an image depicts a minor BEFORE touching it, so the denial was not
   * neutral.
   */
  it('ALLOWS ageClassification/mediaRating/wdTagging — a retracted denial', () => {
    for (const t of ['ageClassification', 'mediaRating', 'wdTagging']) {
      expect(isPlatformInternalStepType(t)).toBe(false);
      expect(() => assertStepTypeAllowed(t)).not.toThrow();
    }
  });

  /**
   * 🔴 THE EXPORTED SET IS GENUINELY IMMUTABLE — the assertion that a previous
   * draft's `Object.freeze(new Set([...]))` could not make.
   *
   * Measured: `Set.prototype.add`/`delete` write internal slots, not properties,
   * so `Object.freeze` was inert and `.delete('xGuardModeration')` SUCCEEDED on
   * the frozen Set, silently un-denying it. A frozen ARRAY does reject
   * mutation, and the lookup Set is module-private.
   */
  it('the exported denylist cannot be mutated to un-deny a type', () => {
    expect(Object.isFrozen(PLATFORM_INTERNAL_STEP_TYPES)).toBe(true);
    expect(() => {
      (PLATFORM_INTERNAL_STEP_TYPES as string[]).push('textToImage');
    }).toThrow(TypeError);
    // and the guard is unmoved by the attempt
    expect(isPlatformInternalStepType('xGuardModeration')).toBe(true);
    expect(isPlatformInternalStepType('textToImage')).toBe(false);
  });
});

describe('orchestrator denylist — the live seam: the step registry', () => {
  /**
   * 🔴 THIS IS THE ONLY PLACE THE DENYLIST BITES TODAY.
   *
   * No current wire arm lets a block name an arbitrary `$type`, so the property
   * this buys is "a platform-internal type cannot be REGISTERED as a block
   * step", not "a block cannot submit one". Stating the narrower claim is the
   * point — see clause (0a) in `assertStepInvariants`.
   */
  it('no registered step declares a platform-internal orchestratorType', () => {
    const entries = listRegisteredSteps();
    // Positive control: the enumeration is non-empty, so an empty `offenders`
    // is evidence about the population rather than about an empty loop.
    expect(entries.length).toBeGreaterThan(0);
    const offenders = entries
      .filter(([, step]) => isPlatformInternalStepType(step.orchestratorType))
      .map(([id, step]) => `${id} -> ${step.orchestratorType}`);
    expect(offenders).toEqual([]);
  });

  /**
   * MUTATION / REACHABILITY: prove clause (0a) actually RUNS and is not
   * shadowed by an earlier clause. We take a real registered entry, swap only
   * its `orchestratorType` for a denylisted one, and require the registry
   * invariant to reject it WITH THE DENYLIST'S OWN ERROR.
   *
   * A plain `toThrow()` here would be satisfied by clause (9)'s
   * native-extraction guard or any other clause, i.e. green for the wrong
   * reason and still green with (9a) deleted.
   */
  it('assertStepInvariants rejects a denylisted orchestratorType with the denylist error', () => {
    const [id, real] = listRegisteredSteps()[0]!;
    const mutated = { ...real, orchestratorType: 'xGuardModeration' } as typeof real;
    expect(() => assertStepInvariants(id, mutated)).toThrow(PlatformInternalStepTypeError);
  });

  /**
   * The control for the mutation above: the SAME entry, unmutated, must pass
   * the whole invariant set. Without this, a mutated entry that failed for some
   * unrelated structural reason would look like the guard firing.
   */
  it('the same entry passes assertStepInvariants unmutated (control)', () => {
    const [id, real] = listRegisteredSteps()[0]!;
    expect(() => assertStepInvariants(id, real)).not.toThrow();
  });
});
