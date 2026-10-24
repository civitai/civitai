import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The PUBLIC App-catalog grant decision, in isolation.
 *
 * 🔴 LABEL, honestly: this file is UNIT coverage for a module that did not exist
 * before, so it cannot be shown red at the base ref — there is nothing at base for
 * it to import. It pins the decision's shape; the REGRESSION coverage (an anonymous
 * caller is actually served, and `/apps` stays dark) lives in the handler suites
 * `src/tests/api/v1/apps/*`, which ARE red at base because they drive the real
 * handlers through a behaviour that changed.
 *
 * What it structurally cannot see: whether `resolveStoreVisibilityScope` produces
 * anything sane in production (it does not, for an anonymous principal — civitai#3983
 * is still open upstream), and whether the Flipt flag exists. Both are mocked here.
 */

const { mockIsFlipt } = vi.hoisted(() => ({ mockIsFlipt: vi.fn() }));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isFlipt: mockIsFlipt,
}));

import {
  decidePublicCatalogScope,
  PUBLIC_APPS_CATALOG_DISABLED_FLAG,
  PUBLIC_APPS_CATALOG_SCOPE,
  resolvePublicAppsCatalogScope,
} from '~/server/services/blocks/public-apps-catalog';
import {
  storeScopeRank,
  narrowStoreScope,
  type StoreVisibilityScope,
} from '~/shared/utils/store-visibility-scope';

beforeEach(() => {
  vi.clearAllMocks();
  // The flag's ABSENT state. `isFlipt` returns false for a flag that does not exist
  // and for an unreachable Flipt, so this is also the as-merged production config.
  mockIsFlipt.mockResolvedValue(false);
});

describe('resolvePublicAppsCatalogScope — the public grant', () => {
  it('grants the public catalog to a caller who resolved `none`', async () => {
    await expect(resolvePublicAppsCatalogScope('none', 'rest-list')).resolves.toBe(
      PUBLIC_APPS_CATALOG_SCOPE
    );
  });

  // The KILL-SWITCH POLARITY, which is the one property that decides whether merging
  // this empties a live endpoint. Asserted as a discrimination so it cannot pass on a
  // function that ignores the flag in either direction.
  it('POLARITY: flag ABSENT/false → granted; flag true → withheld', async () => {
    mockIsFlipt.mockResolvedValue(false);
    await expect(resolvePublicAppsCatalogScope('none', 'rest-list')).resolves.toBe('full');
    mockIsFlipt.mockResolvedValue(true);
    await expect(resolvePublicAppsCatalogScope('none', 'rest-list')).resolves.toBe('none');
  });

  it('reads the kill switch GLOBALLY (no entityId/context — these callers have none)', async () => {
    await resolvePublicAppsCatalogScope('none', 'rest-list');
    expect(mockIsFlipt).toHaveBeenCalledTimes(1);
    // A segmented/percentage flag cannot match a global eval; the flag key and the
    // absence of an entity are both part of the operator contract in the module doc.
    expect(mockIsFlipt.mock.calls[0]).toEqual([PUBLIC_APPS_CATALOG_DISABLED_FLAG]);
  });
});

describe('resolvePublicAppsCatalogScope — a caller AT OR ABOVE the floor is never touched', () => {
  // 🔴 "Privileged" is defined by RANK against the floor, not by "resolved something".
  // With today's `full` floor that is the `full` callers and only them: a
  // `public-external` caller is BELOW the floor and must meet the grant (see the
  // truth table), which is civitai#4048 — the old `scope !== 'none'` short-circuit
  // sent them past a grant that would have widened them.
  it('passes `full` through verbatim, and does not even READ the kill switch', async () => {
    await expect(resolvePublicAppsCatalogScope('full', 'rest-list')).resolves.toBe('full');
    expect(mockIsFlipt).not.toHaveBeenCalled();
  });

  it('still passes `full` through with the kill switch ON', async () => {
    mockIsFlipt.mockResolvedValue(true);
    await expect(resolvePublicAppsCatalogScope('full', 'rest-list')).resolves.toBe('full');
  });

  it('a `public-external` caller keeps `public-external` when the switch is ON', async () => {
    // The withheld branch returns the caller's OWN scope. It withdraws the public
    // FLOOR; it does not revoke what they resolved for themselves.
    mockIsFlipt.mockResolvedValue(true);
    await expect(resolvePublicAppsCatalogScope('public-external', 'rest-list')).resolves.toBe(
      'public-external'
    );
  });
});

describe('resolvePublicAppsCatalogScope — #4041 narrowing is applied FIRST', () => {
  /** Every runtime shape production's missing scope can arrive as. */
  const ABSENT: [string, unknown][] = [
    ['undefined (what production records for an anonymous principal)', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a wrong-cased scope', 'FULL'],
    ['a near-miss', 'public_external'],
    ['a scope from a hypothetical newer branch', 'public-onsite'],
    ['a number', 1],
    ['a boolean', true],
    ['an object', { scope: 'full' }],
    ['a Promise (an unawaited resolver call)', Promise.resolve('full')],
  ];

  // 🔴 THE #3983 INVARIANT, restated for a public surface: an uninterpretable value
  // must land on the same branch as a resolved `none`, never on its own wider one.
  // Both configurations are checked, because "same as none" is only meaningful if
  // `none` itself can be closed.
  it.each(ABSENT)('%s is treated EXACTLY as a resolved `none` — switch off', async (_l, value) => {
    const absent = await resolvePublicAppsCatalogScope(value, 'rest-list');
    const none = await resolvePublicAppsCatalogScope('none', 'rest-list');
    expect(absent).toBe(none);
  });

  it.each(ABSENT)('%s is treated EXACTLY as a resolved `none` — switch on', async (_l, value) => {
    mockIsFlipt.mockResolvedValue(true);
    const absent = await resolvePublicAppsCatalogScope(value, 'rest-list');
    const none = await resolvePublicAppsCatalogScope('none', 'rest-list');
    expect(absent).toBe(none);
    // And that shared answer is the closed one — so an absent scope cannot slip past
    // an operator who has deliberately withheld the catalog.
    expect(absent).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// civitai#4048 — the privilege INVERSION, and the invariant that replaces the
// short-circuit which used to prevent it for free.
// ---------------------------------------------------------------------------

/** Every caller shape, including the ones production actually produces. */
const CALLERS: [string, unknown][] = [
  ['full', 'full'],
  ['public-external', 'public-external'],
  ['none', 'none'],
  ['undefined (what production carries for an anonymous principal)', undefined],
  ['garbage', 'not-a-scope'],
];

describe('🔴 civitai#4048: the FULL truth table — returned scope AND recorded outcome', () => {
  /** The recorded outcome, read off the decision rather than the counter registry. */
  async function decide(resolved: unknown, disabled: boolean) {
    return decidePublicCatalogScope(resolved, PUBLIC_APPS_CATALOG_SCOPE, async () => disabled);
  }

  // Switch OFF — the as-merged production configuration. The inversion lives in the
  // `public-external` row: BEFORE this change it returned `public-external`
  // (outcome `privileged`), so a signed-in cohort member read FEWER listings from
  // `GET /api/v1/apps` than an anonymous caller did. Measured live: 4 vs 14.
  it.each([
    ['full', 'full', 'privileged'],
    ['public-external', 'full', 'granted'],
    ['none', 'full', 'granted'],
    [undefined, 'full', 'granted'],
    ['not-a-scope', 'full', 'granted'],
  ] as [unknown, StoreVisibilityScope, string][])(
    'switch OFF: %s → %s (%s)',
    async (input, expectedScope, expectedOutcome) => {
      const d = await decide(input, false);
      expect(d.scope).toBe(expectedScope);
      expect(d.outcome).toBe(expectedOutcome);
    }
  );

  // Switch ON — the grant is withdrawn, NOT the caller's own entitlement.
  it.each([
    ['full', 'full', 'privileged'],
    ['public-external', 'public-external', 'withheld'],
    ['none', 'none', 'withheld'],
    [undefined, 'none', 'withheld'],
    ['not-a-scope', 'none', 'withheld'],
  ] as [unknown, StoreVisibilityScope, string][])(
    'switch ON: %s → %s (%s)',
    async (input, expectedScope, expectedOutcome) => {
      const d = await decide(input, true);
      expect(d.scope).toBe(expectedScope);
      expect(d.outcome).toBe(expectedOutcome);
    }
  );

  // The table above is only meaningful if the two halves DISAGREE somewhere — a
  // resolver that ignored the switch entirely would satisfy neither half, but a
  // resolver that ignored the INPUT would satisfy a table nobody re-read. Assert the
  // discrimination explicitly.
  it('the two halves are NOT the same table (the switch and the input both matter)', async () => {
    const off = await Promise.all(CALLERS.map(([, v]) => decide(v, false)));
    const on = await Promise.all(CALLERS.map(([, v]) => decide(v, true)));
    expect(off.map((d) => d.scope)).not.toEqual(on.map((d) => d.scope));
    expect(new Set(off.map((d) => d.outcome)).size).toBeGreaterThan(1);
    expect(new Set(on.map((d) => d.scope)).size).toBeGreaterThan(1);
  });

  // …and the same table through the REAL entry point, so the extraction of
  // `decidePublicCatalogScope` cannot drift from what the handlers actually call.
  it.each(CALLERS)(
    'the real resolver agrees with the decision for %s, both switch states',
    async (_label, value) => {
      for (const disabled of [false, true]) {
        mockIsFlipt.mockResolvedValue(disabled);
        const viaResolver = await resolvePublicAppsCatalogScope(value, 'rest-list');
        expect(viaResolver, `disabled=${disabled}`).toBe((await decide(value, disabled)).scope);
      }
    }
  );
});

/**
 * 🔴 THE NEVER-NARROWS INVARIANT, as its own named property.
 *
 * The pre-#4048 code got this for free: it returned early for every non-`none`
 * scope, so it could not possibly hand back less than it was given. Restructuring
 * around a floor removes that guarantee — the withheld branch is one keystroke
 * (`'none'`) away from narrowing the external-only cohort on a surface they are
 * entitled to read, and that keystroke is what a reader would expect a "kill switch"
 * to contain. So the invariant is stated, not inferred.
 */
describe('🔴 NEVER NARROWS: rank(result) >= rank(input), for every input × switch state', () => {
  it.each(CALLERS)('%s', async (_label, value) => {
    const own = narrowStoreScope(value);
    for (const disabled of [false, true]) {
      mockIsFlipt.mockResolvedValue(disabled);
      const out = await resolvePublicAppsCatalogScope(value, 'rest-list');
      expect(
        storeScopeRank(out),
        `input=${own} disabled=${disabled} → ${out}`
      ).toBeGreaterThanOrEqual(storeScopeRank(own));
    }
  });

  // POSITIVE CONTROL for the assertion above: `toBeGreaterThanOrEqual` over ranks is
  // a real discrimination, not a comparison that can only ever hold. A deliberately
  // narrowing decision must fail it.
  it('POSITIVE CONTROL: a narrowing result WOULD fail this assertion', () => {
    expect(() =>
      expect(storeScopeRank('none')).toBeGreaterThanOrEqual(storeScopeRank('public-external'))
    ).toThrow();
  });
});

/**
 * The floor constant is documented as a ONE-LINE product edit ("narrow the public
 * catalog to `public-external`"). A resolver that named scopes instead of comparing
 * ranks would break silently under that edit — a `full` caller would stop
 * short-circuiting, or a `public-external` caller would be "widened" to a narrower
 * floor. Run the narrowed configuration against the REAL decision function rather
 * than reasoning about it.
 */
describe('🔴 parameterised over the FLOOR: the narrowed-floor configuration still holds', () => {
  const NARROW: StoreVisibilityScope = 'public-external';

  it('a `full` caller still short-circuits as `privileged` under a `public-external` floor', async () => {
    const readSwitch = vi.fn(async () => false);
    const d = await decidePublicCatalogScope('full', NARROW, readSwitch);
    expect(d).toEqual({ scope: 'full', outcome: 'privileged' });
    // …and still does not pay for the kill-switch read.
    expect(readSwitch).not.toHaveBeenCalled();
  });

  it('a `public-external` caller short-circuits too (at the floor, not above it)', async () => {
    const readSwitch = vi.fn(async () => false);
    const d = await decidePublicCatalogScope('public-external', NARROW, readSwitch);
    expect(d).toEqual({ scope: 'public-external', outcome: 'privileged' });
    expect(readSwitch).not.toHaveBeenCalled();
  });

  it('a `none`/absent caller is lifted to the NARROWED floor, not to `full`', async () => {
    for (const input of ['none', undefined, 'nonsense']) {
      const d = await decidePublicCatalogScope(input, NARROW, async () => false);
      expect(d, `input=${String(input)}`).toEqual({
        scope: 'public-external',
        outcome: 'granted',
      });
    }
  });

  it('never narrows under the narrowed floor either, in both switch states', async () => {
    for (const [, value] of CALLERS)
      for (const disabled of [false, true]) {
        const own = narrowStoreScope(value);
        const d = await decidePublicCatalogScope(value, NARROW, async () => disabled);
        expect(storeScopeRank(d.scope), `input=${own} disabled=${disabled}`).toBeGreaterThanOrEqual(
          storeScopeRank(own)
        );
      }
  });

  // The floor sweep is the general statement: for EVERY floor in the closed set, and
  // every caller, the decision never narrows and never exceeds max(own, floor).
  it('over EVERY floor × EVERY caller × both switch states', async () => {
    let cases = 0;
    for (const floor of ['none', 'public-external', 'full'] as StoreVisibilityScope[])
      for (const [, value] of CALLERS)
        for (const disabled of [false, true]) {
          const own = narrowStoreScope(value);
          const d = await decidePublicCatalogScope(value, floor, async () => disabled);
          const ceiling = Math.max(storeScopeRank(own), storeScopeRank(floor));
          expect(storeScopeRank(d.scope), `${own}/${floor}/${disabled}`).toBeGreaterThanOrEqual(
            storeScopeRank(own)
          );
          expect(storeScopeRank(d.scope), `${own}/${floor}/${disabled}`).toBeLessThanOrEqual(
            ceiling
          );
          cases++;
        }
    expect(cases).toBe(30);
  });
});
