import { describe, expect, it } from 'vitest';
import { assertDifferential, runOracle, type AnyRecord } from './differential';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

/**
 * Proves the differential harness itself works before any port depends on it:
 * the oracle loads under vitest, the ext shape is right, real inputs resolve,
 * and the comparator both PASSES on an identical implementation and FAILS on a
 * divergent one. A harness that cannot fail is worse than no harness.
 */

export const TEST_CTX: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

/** A "port" that IS the oracle — the identity case must compare clean. */
const identityPort = {
  parse(raw: AnyRecord, ext: never) {
    const result = runOracle(raw, ext as unknown as GenerationCtx);
    return result.success
      ? { success: true as const, data: result.data, state: result.data }
      : { success: false as const, errors: result.errors as Record<string, unknown> };
  },
};

describe('differential harness', () => {
  it('the oracle resolves real generation input under vitest', () => {
    const result = runOracle({ workflow: 'txt2img', ecosystem: 'Flux1', prompt: 'a cat' }, TEST_CTX);
    expect(result.success).toBe(true);
    expect(result.data.workflow).toBe('txt2img');
  });

  it('passes when the port matches the oracle exactly', () => {
    assertDifferential(
      identityPort,
      { name: 'identity', input: { workflow: 'txt2img', ecosystem: 'Flux1', prompt: 'a cat' } },
      TEST_CTX
    );
  });

  it('FAILS on an added key, a dropped key, and a changed value', () => {
    const addsKey = {
      parse(raw: AnyRecord, ext: never) {
        const r = runOracle(raw, ext as unknown as GenerationCtx);
        return { success: true as const, data: { ...r.data, bogus: 1 }, state: r.data };
      },
    };
    expect(() =>
      assertDifferential(addsKey, { name: 'adds', input: { workflow: 'txt2img' } }, TEST_CTX)
    ).toThrow();

    const dropsKey = {
      parse(raw: AnyRecord, ext: never) {
        const r = runOracle(raw, ext as unknown as GenerationCtx);
        const { workflow: _dropped, ...rest } = r.data;
        return { success: true as const, data: rest, state: rest };
      },
    };
    expect(() =>
      assertDifferential(dropsKey, { name: 'drops', input: { workflow: 'txt2img' } }, TEST_CTX)
    ).toThrow();

    const changesValue = {
      parse(raw: AnyRecord, ext: never) {
        const r = runOracle(raw, ext as unknown as GenerationCtx);
        return {
          success: true as const,
          data: { ...r.data, workflow: 'MUTATED' },
          state: r.data,
        };
      },
    };
    expect(() =>
      assertDifferential(changesValue, { name: 'changes', input: { workflow: 'txt2img' } }, TEST_CTX)
    ).toThrow();
  });

  it('a declared delta that is NOT real fails too (stale allowlists cannot hide)', () => {
    expect(() =>
      assertDifferential(
        identityPort,
        {
          name: 'stale',
          input: { workflow: 'txt2img', ecosystem: 'Flux1', prompt: 'a cat' },
          added: ['neverAdded (bogus reason)'],
        },
        TEST_CTX
      )
    ).toThrow();
  });

  it('refuses key-delta declarations on a case where BOTH sides fail', () => {
    // A failed parse has no data, so a key-delta claim there is uncheckable —
    // the harness must reject it rather than silently skip verification.
    expect(() =>
      assertDifferential(
        identityPort,
        { name: 'unverifiable', input: { workflow: 'nonsense-workflow' }, added: ['whatever (x)'] },
        TEST_CTX
      )
    ).toThrow();
  });
});
