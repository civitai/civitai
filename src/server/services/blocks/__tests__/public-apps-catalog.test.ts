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
  PUBLIC_APPS_CATALOG_DISABLED_FLAG,
  PUBLIC_APPS_CATALOG_SCOPE,
  resolvePublicAppsCatalogScope,
} from '~/server/services/blocks/public-apps-catalog';

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

describe('resolvePublicAppsCatalogScope — a privileged caller is never touched', () => {
  it.each(['full', 'public-external'] as const)(
    'passes `%s` through verbatim, and does not even READ the kill switch',
    async (scope) => {
      await expect(resolvePublicAppsCatalogScope(scope, 'rest-list')).resolves.toBe(scope);
      // Short-circuit, proven by absence of the eval: no configuration of the switch
      // can narrow, widen or slow a caller who resolved a scope of their own.
      expect(mockIsFlipt).not.toHaveBeenCalled();
    }
  );

  it.each(['full', 'public-external'] as const)(
    'still passes `%s` through with the kill switch ON',
    async (scope) => {
      mockIsFlipt.mockResolvedValue(true);
      await expect(resolvePublicAppsCatalogScope(scope, 'rest-list')).resolves.toBe(scope);
    }
  );
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
