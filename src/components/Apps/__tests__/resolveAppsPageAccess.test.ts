import { describe, it, expect } from 'vitest';
import { resolveAppsPageAccess } from '../resolveAppsPageAccess';

/**
 * F-E E1 — SSR gate-ordering invariant for /apps.
 *
 * The marketplace is anon-capable but stays DARK behind the mod-segmented flag.
 * These tests pin the GATING INVARIANT so it FAILS if the gate is reordered,
 * removed, or a session→login redirect is reintroduced:
 *   - No flag → notFound, REGARDLESS of session (gate is the only control,
 *     and it's a hard notFound — never a login redirect).
 *   - Flag granted + NO session → renders (the dark anon read path).
 *   - Flag granted + session → renders.
 */

describe('resolveAppsPageAccess — gating invariant', () => {
  it('no appBlocks flag → notFound (gate intact, even with no session)', () => {
    expect(resolveAppsPageAccess({ features: { appBlocks: false } })).toEqual({ notFound: true });
  });

  it('undefined/null features → notFound (fails closed)', () => {
    expect(resolveAppsPageAccess({ features: undefined })).toEqual({ notFound: true });
    expect(resolveAppsPageAccess({ features: null })).toEqual({ notFound: true });
    expect(resolveAppsPageAccess({ features: {} })).toEqual({ notFound: true });
  });

  it('flag granted + NO session → renders (the dark anon read path, no login redirect)', () => {
    const result = resolveAppsPageAccess({ features: { appBlocks: true } });
    expect(result).toEqual({ props: {} });
    // Critically: it must NOT be a redirect. The old behavior bounced anon to
    // /login; E1 removes that so the page renders behind the flag.
    expect(result).not.toHaveProperty('redirect');
    expect(result).not.toHaveProperty('notFound');
  });

  it('flag granted (mod path today) → renders', () => {
    expect(resolveAppsPageAccess({ features: { appBlocks: true } })).toEqual({ props: {} });
  });
});
