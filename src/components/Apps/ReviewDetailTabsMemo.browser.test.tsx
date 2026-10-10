import { useMemo, useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as OnsiteModule from '~/components/Apps/OnsiteReviewModal';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * 🔴 THE MEMO IS A PERFORMANCE CONTRACT, AND IT WAS INERT WHEN FIRST WRITTEN.
 *
 * `ReviewDetailView` owns a 60-second tick so the submitter line and the decision banner can
 * re-age their "3h ago" strings. The tab subtree is a SIBLING of those two and nothing
 * between them was memoised — so every minute, to change one string, React re-rendered every
 * mounted panel: up to 300 collapsed file cards, and every open diff table's full row set
 * (the row `useMemo`s preserve the ARRAYS, not the elements, so each `<tr>`/`<td>`/`<Text>`
 * is recreated and reconciled). `memo()` on the subtree is what stops that.
 *
 * 🔴 TWO HALVES, AND AN EARLIER DRAFT OF THIS HEADER CONFLATED THEM. The tick lives one level
 * DOWN, inside `ReviewDetailView`, and a child's state update never re-renders its parent —
 * so the PAGE does not re-render on a tick, `selection` keeps its identity whatever built it,
 * and `memo()` alone covers the tick. The page's `useMemo` covers the OTHER re-render
 * sources — the feature flags resolving, a refetch that returns equal data, a parent update —
 * where a `selection` rebuilt in the render body would hand this memo a new object and buy
 * nothing.
 *
 * This file pins the MEMO's half: given a stable prop it bails out, and given an unstable one
 * it does not. The PAGE's half — that the real page keeps the identity across its own
 * re-renders — is pinned behaviourally in
 * `src/tests/pages/apps/review/review-detail-page.browser.test.tsx`, because only the real
 * page can be wrong about it. Neither claim is greppable: "`memo()` is present" and "`memo()`
 * does work" are different statements and only the first is a search.
 *
 * 🔴 WHY THE COUNTER IS A MOCKED CHILD AND NOT A `<Profiler>`. A Profiler wrapped around the
 * memoised element was the obvious instrument and it CANNOT MEASURE THIS: the Profiler
 * element is recreated by the parent on every tick, so React re-renders the Profiler itself
 * and `onRender` fires whether or not its child bailed out. Measured — both arms reported
 * exactly 1, i.e. the instrument reported the same number for the fixed and the broken
 * case. The count has to come from INSIDE the memoised subtree, which is what a counting
 * stub of a child it renders on the default tab gives.
 */

const counters = vi.hoisted(() => ({ scopes: 0 }));

/*
  🔴 SPREAD THE ORIGINAL, then override the one child. A one-key factory for this module
  would make every other export (`ReviewAgentSection`, `ReviewFilesSection`, …) `undefined`
  for the view under test, and an import-time failure collects 0 tests rather than failing
  one. `local-rules/no-wholesale-module-mock` reds on the narrow form.
*/
vi.mock('~/components/Apps/OnsiteReviewModal', async (importOriginal) => ({
  ...(await importOriginal<typeof OnsiteModule>()),
  ManifestScopes: () => {
    counters.scopes += 1;
    return <div data-testid="scopes-render-counter" />;
  },
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ appBlocks: true }),
}));

const { ReviewDetailTabsView } = await import('./ReviewDetailTabsView');

const REQUEST = {
  id: 'pubreq_01HZX',
  appBlockId: null as string | null,
  slug: 'gen-matrix',
  version: '0.2.0',
  submittedAt: new Date('2026-01-01T09:00:00Z'),
  bundleSizeBytes: '421888',
  bundleSha256: 'a'.repeat(64),
  manifest: {
    name: 'Gen Matrix',
    blockId: 'gen-matrix',
    version: '0.2.0',
    scopes: ['ai:write:budgeted', 'models:read:self'],
    targets: [{ slotId: 'model.sidebar_top', priority: 10 }],
  },
  fileSummary: { files: [], added: [], removed: [], changed: [] },
  manifestDiffSummary: { kind: 'first-version', fields: ['name'] },
  submittedBy: { id: 7, username: 'builder', deletedAt: null, image: null },
  iconUrl: null,
  coverUrl: null,
};

const TICKS = 3;

/**
 * Re-renders a parent `TICKS` times, handing the tabs view either a stable `selection` (what
 * the page's `useMemo` produces) or a fresh object each render (what an inline literal would
 * produce), and returns how many times the memoised subtree actually re-rendered.
 *
 * Each tick is awaited separately: three synchronous `setState` calls are BATCHED into one
 * render, which would make the broken arm look like one re-render instead of three.
 */
const countSubtreeRenders = async (stable: boolean) => {
  counters.scopes = 0;
  // Assigned by the harness on its first render; throwing until then makes a harness that
  // never rendered fail loudly instead of ticking nothing and reporting a clean zero.
  let bump: () => void = () => {
    throw new Error('the harness never rendered, so no tick was dispatched');
  };
  const Harness = () => {
    const [n, setN] = useState(0);
    bump = () => setN((v) => v + 1);
    const pinned = useMemo(() => ({ request: REQUEST as never, mode: 'pending' as const }), []);
    const selection = stable ? pinned : { request: REQUEST as never, mode: 'pending' as const };
    return (
      <>
        {/* A sibling that re-renders on every parent render, standing in for whatever made
            the page re-render — flags resolving, a refetch, a parent update. */}
        <span data-testid="memo-harness-tick">{n}</span>
        <ReviewDetailTabsView selection={selection} />
      </>
    );
  };
  await renderWithProviders(<Harness />);
  await expect.element(page.getByTestId('scopes-render-counter')).toBeInTheDocument();
  const onMount = counters.scopes;
  for (let i = 1; i <= TICKS; i += 1) {
    bump();
    await expect.element(page.getByTestId('memo-harness-tick')).toHaveTextContent(String(i));
  }
  return { onMount, afterTicks: counters.scopes - onMount };
};

describe('the tab subtree’s memo', () => {
  test('🔴 POSITIVE CONTROL: a FRESH `selection` each render re-renders the whole subtree', async () => {
    // The pre-fix behaviour, and the proof the counter can move at all — without it, a zero
    // in the case below is indistinguishable from a probe wired to nothing.
    const { onMount, afterTicks } = await countSubtreeRenders(false);
    expect(onMount, 'the subtree rendered at all').toBeGreaterThan(0);
    expect(afterTicks, 'an unstable prop defeats the memo on every tick').toBe(TICKS);
  });

  test('🔴 …and a STABLE `selection` re-renders it ZERO times while the clock ticks', async () => {
    const { onMount, afterTicks } = await countSubtreeRenders(true);
    expect(onMount, 'the subtree rendered at all').toBeGreaterThan(0);
    expect(afterTicks, 'the memo must bail out on every tick').toBe(0);
  });
});
