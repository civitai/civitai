import { describe, expect, it } from 'vitest';
import {
  CLIENT_DECLARABLE_RELAY_FALLBACK_OUTCOMES,
  OTHER_RELAY_FALLBACK_OUTCOME,
  RELAY_FALLBACK_FAILURE_REASONS,
  RELAY_FALLBACK_OUTCOMES,
  UNKNOWN_RELAY_FALLBACK_OUTCOME,
  sanitizeRelayFallbackOutcome,
} from '~/utils/relay-fallback-outcome';

/**
 * The relay-outcome sanitiser, and the three tiers it narrows against.
 *
 * These are NEW-FEATURE tests — the module did not exist before this change, so there is no
 * revision at which they could be shown red against a defect. Each is instead verified by
 * mutation; the one worth recording is the membership test, where replacing the `Set` with an
 * object-literal lookup previously left the whole suite green.
 */
describe('sanitizeRelayFallbackOutcome', () => {
  it('passes every CLIENT-DECLARABLE outcome through unchanged', () => {
    // Iterates the exported tuple rather than a hand-written list, so a value added to the
    // vocabulary is exercised here instead of silently skipping the only pass-through case.
    // Also the positive control: a sanitiser returning `other` unconditionally would satisfy
    // every rejection case below while erasing the whole discriminator.
    for (const outcome of CLIENT_DECLARABLE_RELAY_FALLBACK_OUTCOMES) {
      expect(sanitizeRelayFallbackOutcome(outcome), outcome).toBe(outcome);
    }
  });

  it('reads ONLY `undefined` as absent, unlike the producer header sanitiser', () => {
    // 🔴 The deliberate divergence from `sanitizeImageUploadRelayProducer`, which maps every
    // non-string to `unknown`. This value arrives in a JSON body, so a present non-string is a
    // client computing a bad value — not one too old to send anything — and `unknown` is the row
    // a rollout is graded on. `null` is the case that separates the two sanitisers.
    expect(sanitizeRelayFallbackOutcome(undefined)).toBe('unknown');
    for (const arrived of [null, 0, 7, true, false, {}, [], ['rescued'], () => 'rescued']) {
      expect(sanitizeRelayFallbackOutcome(arrived), String(arrived)).toBe('other');
    }
  });

  it('🔴 maps a client-declared SERVER bucket to `other` — those are not declarable', () => {
    // `unknown` means "no outcome was sent", and a falling `unknown` is read as stale bundles
    // clearing. A client able to declare it could make the rollout look finished.
    expect(sanitizeRelayFallbackOutcome(UNKNOWN_RELAY_FALLBACK_OUTCOME)).toBe('other');
    expect(sanitizeRelayFallbackOutcome(OTHER_RELAY_FALLBACK_OUTCOME)).toBe('other');
  });

  it('cannot be walked through a prototype key', () => {
    // 🔴 The reason the membership test is a `Set` and not an object literal. Every string here
    // answers truthy to `{}[key]`, so an object-backed lookup emits them as field values —
    // `__proto__` especially, since it also exists on any JSON body a caller controls. Measured:
    // with the lookup swapped for `Object.fromEntries(...)[input]` the rest of the relay suite
    // stays green and only this case fails.
    for (const bad of [
      '__proto__',
      'constructor',
      'prototype',
      'toString',
      'hasOwnProperty',
      'valueOf',
    ]) {
      expect(sanitizeRelayFallbackOutcome(bad), bad).toBe('other');
    }
  });

  it('cannot produce a value outside the declared set, for any input', () => {
    // 🔴 THE PROPERTY, stated as one rather than as a list of cases: a field-value injection is
    // precisely "the output was not a member", so this survives someone adding an outcome.
    const injections: unknown[] = [
      'bad_body ',
      ' bad_body',
      'BAD_BODY',
      'bad',
      'rescued,bad_body',
      '{"relayOutcome":"rescued"}',
      'a'.repeat(4096),
      { toString: () => 'rescued' },
      new String('rescued'), // eslint-disable-line no-new-wrappers
    ];
    for (const input of injections) {
      const out = sanitizeRelayFallbackOutcome(input);
      expect(
        [UNKNOWN_RELAY_FALLBACK_OUTCOME, OTHER_RELAY_FALLBACK_OUTCOME],
        `input=${String(input)} produced ${out}`
      ).toContain(out);
    }
  });
});

describe('the relay-outcome vocabulary', () => {
  const serverOnly = (RELAY_FALLBACK_OUTCOMES as readonly string[]).filter(
    (o) => !(CLIENT_DECLARABLE_RELAY_FALLBACK_OUTCOMES as readonly string[]).includes(o)
  );

  it('🔴 keeps every failure reason client-declarable, and the tiers exhaustive', () => {
    // 🔴 THE RELATIONSHIP THE SPREADS CLAIM, enforced at runtime. Each tier spreads the one
    // below, so these hold by construction today — and that is exactly why they are asserted:
    // a later edit replacing a spread with a restated list is the drift that makes a value
    // exist in one tier and be missing from another, and nothing else would notice.
    //
    // Asserted as `length + 2` against the tuple rather than against a written-down count, so
    // adding an outcome cannot satisfy it by moving the number it is compared with.
    for (const reason of RELAY_FALLBACK_FAILURE_REASONS) {
      expect(
        CLIENT_DECLARABLE_RELAY_FALLBACK_OUTCOMES as readonly string[],
        `"${reason}" is a failure reason the client reports but cannot declare`
      ).toContain(reason);
    }
    expect(
      CLIENT_DECLARABLE_RELAY_FALLBACK_OUTCOMES.length,
      'the declarable tier is the failure reasons plus `rescued` and `not_attempted`'
    ).toBe(RELAY_FALLBACK_FAILURE_REASONS.length + 2);
    expect(
      RELAY_FALLBACK_OUTCOMES.length,
      'every logged outcome must be either client-declarable or one of the two server buckets'
    ).toBe(CLIENT_DECLARABLE_RELAY_FALLBACK_OUTCOMES.length + 2);
  });

  it('🔴 keeps the declarable tier a STRICT subset — the server buckets stay undeclarable', () => {
    // NAMED, not counted: a `length` comparison forbids only equality, so planting `unknown`
    // into the declarable tuple would leave a count-based version green while carrying this
    // sentence. The sibling's guard was defective in exactly that way.
    for (const declarable of CLIENT_DECLARABLE_RELAY_FALLBACK_OUTCOMES) {
      expect(
        RELAY_FALLBACK_OUTCOMES as readonly string[],
        `"${declarable}" is declarable but is not a logged outcome — it would reach the event ` +
          `stream as a value no reader of this field can group on`
      ).toContain(declarable);
    }
    for (const bucket of [UNKNOWN_RELAY_FALLBACK_OUTCOME, OTHER_RELAY_FALLBACK_OUTCOME]) {
      expect(
        CLIENT_DECLARABLE_RELAY_FALLBACK_OUTCOMES as readonly string[],
        `"${bucket}" must stay undeclarable — it is a statement about the SERVER's reading`
      ).not.toContain(bucket);
    }
    expect(serverOnly, 'there must BE server-only buckets, or the subset asserts nothing').toEqual([
      UNKNOWN_RELAY_FALLBACK_OUTCOME,
      OTHER_RELAY_FALLBACK_OUTCOME,
    ]);
  });

  it('refuses every server-only bucket from a client, whatever the set grows to', () => {
    for (const bucket of serverOnly) {
      expect(sanitizeRelayFallbackOutcome(bucket), bucket).toBe(OTHER_RELAY_FALLBACK_OUTCOME);
    }
  });
});
