import { describe, expect, it } from 'vitest';
import { serverSchema } from '~/env/server-schema';
import { TRPC_MAX_BATCH_SIZE } from '~/shared/constants/trpc.constants';

/**
 * TRPC_MAX_BATCH_SIZE is the server-side cap on how many procedure calls one batched tRPC
 * request may carry. Its entire reason for being an env var is MID-INCIDENT correction: raising
 * it is a config change on a Deployment instead of an image build plus a canary rollout.
 *
 * 🔴 WHY THIS IS TESTED AT THE SCHEMA. `serverSchema` is parsed once by `src/env/server.ts`,
 * which THROWS on any invalid field. With the previous `.default(...)` spelling, a typo in that
 * Deployment value ('' / '0' / '-5' / 'abc' / '12.5' / ' ') did not fall back to the default —
 * it failed validation and crashed the ENTIRE app boot. An emergency lever that takes the fleet
 * down when mistyped is worse than no lever, because it is reached for under exactly the
 * conditions that produce typos. `.catch(...)` degrades any parse/validation failure to the
 * compiled-in constant, i.e. to "the cap we shipped".
 *
 * These cases pin BEHAVIOUR — resolved value and does-not-throw — not the spelling of the
 * schema expression, so any future refactor that preserves the fail-soft contract stays green
 * and any that loses it goes red. `field.parse` exercises the real schema expression, taken off
 * `serverSchema.shape`, not a paraphrase of it.
 */
const field = serverSchema.shape.TRPC_MAX_BATCH_SIZE;

describe('TRPC_MAX_BATCH_SIZE env fail-soft', () => {
  it('falls back to the compiled-in cap when unset — an unset env is the shipped default', () => {
    expect(() => field.parse(undefined)).not.toThrow();
    expect(field.parse(undefined)).toBe(TRPC_MAX_BATCH_SIZE);
  });

  it.each([
    ['empty string', ''],
    ['zero — would reject every batch', '0'],
    ['negative', '-5'],
    ['non-numeric', 'abc'],
    ['a float', '12.5'],
    ['whitespace only', ' '],
  ])('resolves the default for %s WITHOUT throwing (boot survives a typo)', (_label, value) => {
    // 🔴 Both halves matter and they are different claims. `not.toThrow()` is the boot-survival
    // half: a throw here is what `src/env/server.ts` turns into a dead process. The value half
    // is the direction: it must land on the compiled-in cap, never on 0/NaN/undefined, because
    // `maxBatchSize: undefined` is how tRPC spells "no cap at all".
    expect(() => field.parse(value)).not.toThrow();
    expect(field.parse(value), `expected fallback for ${JSON.stringify(value)}`).toBe(
      TRPC_MAX_BATCH_SIZE
    );
  });

  it('passes a valid override through — otherwise the lever does nothing', () => {
    // The positive control for the cases above: if the schema fell back on EVERYTHING, every
    // assertion in this file would still pass while the env var was inert.
    const parsed = field.parse('17');
    expect(parsed).toBe(17);
    expect(typeof parsed).toBe('number');
    // Deliberately not the constant, so "17" cannot be satisfied by the fallback path.
    expect(parsed).not.toBe(TRPC_MAX_BATCH_SIZE);
  });
});
