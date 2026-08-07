import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emitMintAuditToStdout } from '../mint-audit-stdout';

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
    // the event into unparseable fragments.
    emitMintAuditToStdout('e', { scopes: ['a', 'b'], nested: { k: 'v' } });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][0] as string).not.toContain('\n');
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
    // No sampling, no dedupe, no env gate. These are low-volume audit events and the
    // gate counts them; a suppressed line is an undercount that reads as adoption.
    emitMintAuditToStdout('e', { n: 1 });
    emitMintAuditToStdout('e', { n: 2 });
    expect(logSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(logSpy.mock.calls[1][0] as string)).toEqual({ event: 'e', n: 2 });
  });

  it('does not mutate the caller-supplied fields object', () => {
    const fields = { userId: 7 };
    emitMintAuditToStdout('e', fields);
    expect(fields).toEqual({ userId: 7 });
  });
});
