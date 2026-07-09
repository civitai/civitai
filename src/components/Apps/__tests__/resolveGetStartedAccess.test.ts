import { describe, it, expect } from 'vitest';
import { resolveGetStartedAccess } from '../resolveGetStartedAccess';

/**
 * Scope A — SSR gate for `/apps/get-started`.
 *
 * The page gates ONLY on the `appBlocksGetStarted` flag and stays DARK (a hard
 * `notFound`) when the flag is off. These tests pin the GATING INVARIANT so it
 * FAILS if the gate is removed, loosened, or a session→login redirect is
 * introduced:
 *   - No flag (false / undefined / missing features) → notFound (fails closed).
 *   - Flag granted → renders `{ props: {} }`, never a redirect.
 *
 * The flag is staged mod-only today; this resolver gates on the resolved boolean
 * regardless of the flag's availability value, so widening to public needs no
 * change here.
 */
describe('resolveGetStartedAccess — gating invariant', () => {
  it('flag off → notFound', () => {
    expect(resolveGetStartedAccess({ features: { appBlocksGetStarted: false } })).toEqual({
      notFound: true,
    });
  });

  it('undefined flag / features → notFound (fails closed)', () => {
    expect(resolveGetStartedAccess({ features: { appBlocksGetStarted: undefined } })).toEqual({
      notFound: true,
    });
    expect(resolveGetStartedAccess({ features: {} })).toEqual({ notFound: true });
    expect(resolveGetStartedAccess({ features: undefined })).toEqual({ notFound: true });
    expect(resolveGetStartedAccess({})).toEqual({ notFound: true });
  });

  it('flag on → renders (never a redirect)', () => {
    const result = resolveGetStartedAccess({ features: { appBlocksGetStarted: true } });
    expect(result).toEqual({ props: {} });
    expect(result).not.toHaveProperty('redirect');
    expect(result).not.toHaveProperty('notFound');
  });
});
