import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emitMintAuditToStdout } from './mint-audit-stdout';

/**
 * Unit coverage for the mint-audit stdout mirror (#3715).
 *
 * The contract that matters is NEGATIVE: the emitter must not normalise, default, or
 * coerce anything. The step-3 adoption gate of #3703 reads a THREE-valued
 * `requestBudgetedSpend` (`true` / `false` / key omitted), and a helper that helpfully
 * filled in a `false` or a `null` for the omitted case would merge it into the
 * explicit-decline case and make the gate unreadable — silently, with every
 * payload-shape test still green.
 */
describe('emitMintAuditToStdout', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  /** The single JSON line written, parsed back. */
  const written = (): Record<string, unknown> => {
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0][0];
    expect(typeof line).toBe('string');
    return JSON.parse(line as string) as Record<string, unknown>;
  };

  it('writes ONE line, as a single JSON object carrying the event name plus the fields', () => {
    emitMintAuditToStdout('blocks.dev-token.approved-mint', { userId: 7, spendGranted: true });
    expect(written()).toEqual({
      event: 'blocks.dev-token.approved-mint',
      userId: 7,
      spendGranted: true,
    });
  });

  it('writes exactly one line per call, and the line contains no newline (one event per log line)', () => {
    // A log store scraping stdout splits on newlines; an embedded newline would break
    // the event into unparseable fragments. A newline INSIDE a value must be escaped
    // by JSON.stringify rather than ending the line.
    emitMintAuditToStdout('e', { scopes: ['a', 'b'], slug: 'has\nnewline' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).not.toContain('\n');
    // …and the value survived, escaped — this is not passing by dropping the field.
    expect(JSON.parse(line)).toEqual({ event: 'e', scopes: ['a', 'b'], slug: 'has\nnewline' });
  });

  it('an OMITTED key stays OMITTED — never an invented false or null', () => {
    // The three-valued signal's third value. Asserted as key PRESENCE, not truthiness:
    // `false` and absent are both falsy, which is exactly the confusion being guarded.
    emitMintAuditToStdout('e', { spendGranted: true, spendGrantBasis: 'inferred' });
    const out = written();
    expect('requestBudgetedSpend' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('requestBudgetedSpend');
    // Not an empty-payload pass — the rest of the signal did arrive.
    expect(out.spendGrantBasis).toBe('inferred');
  });

  it('a key explicitly set to undefined ALSO stays out of the output (not coerced to null)', () => {
    // The spread at the call sites already omits the key, but if a future caller passed
    // `undefined` the output must still not gain a `null`.
    emitMintAuditToStdout('e', { requestBudgetedSpend: undefined, spendGranted: false });
    const out = written();
    expect('requestBudgetedSpend' in out).toBe(false);
    expect(out.spendGranted).toBe(false);
  });

  it.each([
    ['false', false],
    ['true', true],
  ] as const)('a %s value serialises as the boolean, not a string', (_label, value) => {
    emitMintAuditToStdout('e', { requestBudgetedSpend: value });
    const out = written();
    expect('requestBudgetedSpend' in out).toBe(true);
    expect(out.requestBudgetedSpend).toBe(value);
  });

  it('emits unconditionally — a second call writes a second line', () => {
    // No sampling, no dedupe. These are low-volume audit events and the gate counts
    // them; a suppressed line is an undercount that reads as adoption. NOTE this test
    // covers sampling/dedupe ONLY — it cannot observe an env gate, which is why the
    // NODE_ENV test below exists as a separate case.
    emitMintAuditToStdout('e', { n: 1 });
    emitMintAuditToStdout('e', { n: 2 });
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(logSpy.mock.calls[1][0] as string)).toEqual({ event: 'e', n: 2 });
  });

  it('STILL emits when NODE_ENV is production — the only environment that matters', () => {
    // 🔴 The mutant this exists to kill: wrapping the console.log in
    // `if (process.env.NODE_ENV !== 'production')` left ALL 159 tests green, because
    // vitest runs with NODE_ENV !== 'production' (nothing in src/__tests__/setup.ts or
    // vitest.config.mts sets it), so every other test takes the emitting branch. That
    // mutant's real-world consequence is exactly this PR's target failure mode — the
    // audit event silently absent in production and nowhere else.
    //
    // So this case pins the ONE environment the mirror has to work in.
    //
    // `vi.stubEnv` rather than a direct assignment: NODE_ENV is typed read-only here, so
    // `process.env.NODE_ENV = 'production'` is a TS2540 compile error. stubEnv mutates
    // process.env for real and is undone by `vi.unstubAllEnvs()` in `finally`, so a
    // failure cannot leak the value into sibling tests.
    try {
      vi.stubEnv('NODE_ENV', 'production');
      // The precondition really held — otherwise this test would pass vacuously by
      // simply never entering the environment it claims to cover.
      expect(process.env.NODE_ENV).toBe('production');
      emitMintAuditToStdout('blocks.dev-token.approved-mint', {
        userId: 7,
        spendGrantBasis: 'inferred',
      });
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
        event: 'blocks.dev-token.approved-mint',
        userId: 7,
        spendGrantBasis: 'inferred',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not mutate the caller-supplied fields object', () => {
    const fields = { userId: 7 };
    emitMintAuditToStdout('e', fields);
    expect(fields).toEqual({ userId: 7 });
  });

  /**
   * THE NON-THROWING GUARANTEE IS A TYPE, NOT A TRY/CATCH.
   *
   * `JSON.stringify` throws on exactly two inputs — a BigInt and a circular structure —
   * and `MintAuditFields` makes both unrepresentable. These are COMPILE-time assertions:
   * `@ts-expect-error` fails `pnpm typecheck` if the error does NOT occur, so if someone
   * widens the field type back to `unknown` this block goes red rather than silently
   * becoming decoration. The runtime `expect` below each is incidental — the type error
   * is the assertion.
   *
   * A try/catch was deliberately NOT used: it would turn a would-be crash into a
   * silently missing audit line, which is the same blind spot this module closes.
   */
  describe('the field type makes a throwing JSON.stringify input unrepresentable', () => {
    it('a BigInt is a COMPILE error (it would throw "Do not know how to serialize a BigInt")', () => {
      // Built via BigInt(), NOT the `1n` literal. This repo targets ES2018, so `1n` is
      // itself a target error (TS2737) — an @ts-expect-error over it is satisfied by
      // THAT and would stay green even with the field type widened back to `unknown`.
      // Verified: with the literal, widening the type left this directive "used", so the
      // guard passed for the wrong reason. `BigInt(1)` is typed via lib esnext and
      // produces only the assignability error, which is the one being asserted.
      const big = BigInt(1);
      // @ts-expect-error bigint is not assignable to JsonScalar — this is the guard.
      const bad: Parameters<typeof emitMintAuditToStdout>[1] = { userId: big };
      // Proof the excluded value really would have thrown at runtime.
      expect(() => JSON.stringify(bad)).toThrow(/BigInt/);
    });

    it('a NESTED OBJECT is a COMPILE error — which is what forecloses a circular structure', () => {
      const cyclic: Record<string, unknown> = { userId: 7 };
      cyclic.self = cyclic;
      // @ts-expect-error a nested object is not assignable to JsonScalar | readonly JsonScalar[].
      const bad: Parameters<typeof emitMintAuditToStdout>[1] = { nested: cyclic };
      expect(() => JSON.stringify(bad)).toThrow(/circular|cyclic/i);
    });

    it('every value shape the five production call sites actually pass IS accepted', () => {
      // The other half of the claim: the narrowing must not be so tight that the real
      // payloads stop compiling. This mirrors the union of all five call sites —
      // string, number, boolean, a string[], a string-literal union, and an omitted key.
      const realistic: Parameters<typeof emitMintAuditToStdout>[1] = {
        mode: 'pending' as 'pending' | 'brand-new',
        status: 'suspended',
        userId: 7,
        slug: 'my-app',
        publishRequestId: 'pubreq_01HXYZ',
        appBlockId: 'apb_abc',
        sessionId: undefined,
        scopes: ['ai:write:budgeted', 'user:read:self'],
        spendGranted: true,
        spendGrantBasis: 'inferred' as 'explicit' | 'inferred' | 'none',
      };
      emitMintAuditToStdout('e', realistic);
      const out = written();
      expect(out.spendGrantBasis).toBe('inferred');
      // The undefined-valued key was dropped, not emitted as null.
      expect('sessionId' in out).toBe(false);
    });
  });
});
