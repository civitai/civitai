import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { ResolvedRecentApp } from '~/components/Apps/recentAppsRail';
import type { AvailableBlock } from '~/server/schema/blocks/subscription.schema';

/**
 * RecentlyOpenedAppsView — the presentational "Recently opened" strip. The
 * load-bearing invariant: it renders the passed apps under a "Recently opened"
 * heading, and HIDES the whole section (no heading) when `blocks` is empty (a
 * new viewer with no recents). It reuses AppBlockCard, whose modal dep is
 * stubbed network-free here (covered by its own test).
 */

vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactElement }) => children,
}));
vi.mock('~/components/Apps/AppDetailsModal', () => ({
  AppDetailsModal: ({ opened, block }: { opened: boolean; block: { id: string } }) =>
    opened ? <div data-testid="details-modal">details for {block.id}</div> : null,
}));

const { RecentlyOpenedAppsView, RecentlyOpenedListingsView } = await import('./RecentlyOpenedApps');

function makeBlock(id: string, name: string): AvailableBlock {
  return {
    id,
    blockId: `block-${id}`,
    appId: id,
    appName: name,
    manifest: { name, description: 'desc', targets: [{ slotId: 'app.page' }], hasPage: true },
    installCount: 0,
    category: null,
    externalUrl: null,
    scopesSummary: [],
    avgRating: null,
    reviewCount: 0,
    coverUrl: null,
  };
}

const emptyMaps = {
  subsByBlock: new Map(),
  earningsByAppBlockId: new Map<string, number>(),
};

/**
 * 🔴 RENDER BARRIER — required for every "this is NOT in the document" assertion
 * here.
 *
 * `render()` mounts through a React 18 concurrent root, so the DOM is committed
 * on a later task, not synchronously. A bare `expect(locator.elements())
 * .toHaveLength(0)` straight after `render()` therefore observes an EMPTY
 * container and passes no matter what the component does — it is structurally
 * unfailable (verified by mutation: deleting the component's `entries.length
 * === 0` early-return did not turn it red).
 *
 * Rendering this sentinel alongside the unit under test and AWAITING it forces
 * the commit first, after which "absent" is a real observation.
 */
const RENDER_BARRIER = 'render-barrier';
const RenderBarrier = () => <div data-testid={RENDER_BARRIER} />;

describe('RecentlyOpenedAppsView', () => {
  test('with recents → renders the "Recently opened" section + a card per app', async () => {
    const blocks = [makeBlock('a', 'Alpha App'), makeBlock('b', 'Bravo App')];
    renderWithProviders(
      <RecentlyOpenedAppsView
        blocks={blocks}
        onOpen={vi.fn()}
        canOpenPage={false}
        {...emptyMaps}
      />
    );
    await expect.element(page.getByRole('heading', { name: 'Recently opened' })).toBeInTheDocument();
    // The section is exposed as a labelled region.
    await expect
      .element(page.getByRole('region', { name: 'Recently opened' }))
      .toBeInTheDocument();
    // each app's name appears (the card renders it as a title link)
    await expect.element(page.getByText('Alpha App')).toBeInTheDocument();
    await expect.element(page.getByText('Bravo App')).toBeInTheDocument();
  });

  test('empty blocks → the whole section is HIDDEN (no heading)', async () => {
    renderWithProviders(
      <>
        <RenderBarrier />
        <RecentlyOpenedAppsView blocks={[]} onOpen={vi.fn()} canOpenPage={false} {...emptyMaps} />
      </>
    );
    await expect.element(page.getByTestId(RENDER_BARRIER)).toBeInTheDocument();
    expect(page.getByRole('heading', { name: 'Recently opened' }).elements()).toHaveLength(0);
    expect(page.getByText('Recently opened').elements()).toHaveLength(0);
  });
});

/**
 * The LISTING-shaped rail rendered at the top of the unified `/apps` store.
 * Same hide-when-empty invariant, plus the per-kind link targets.
 */
describe('RecentlyOpenedListingsView', () => {
  const onsite = (over: Partial<ResolvedRecentApp> = {}): ResolvedRecentApp => ({
    id: 'ab_1',
    slug: 'gen-matrix',
    blockId: 'gen-matrix',
    kind: 'onsite',
    hasPage: true,
    name: 'Gen Matrix',
    ...over,
  });

  test('empty entries → the whole rail is HIDDEN (no heading, no layout reserved)', async () => {
    renderWithProviders(
      <>
        <RenderBarrier />
        <RecentlyOpenedListingsView entries={[]} canOpenPage={false} />
      </>
    );
    // Barrier first — see RENDER_BARRIER. Without it this test passes even with
    // the component's empty-guard deleted.
    await expect.element(page.getByTestId(RENDER_BARRIER)).toBeInTheDocument();
    expect(page.getByTestId('apps-recent-rail').elements()).toHaveLength(0);
    expect(page.getByRole('heading', { name: 'Recently opened' }).elements()).toHaveLength(0);
    expect(page.getByText('Recently opened').elements()).toHaveLength(0);
  });

  test('with entries → renders the labelled section + one tile per app', async () => {
    renderWithProviders(
      <RecentlyOpenedListingsView
        entries={[onsite(), onsite({ id: 'ab_2', slug: 'other', blockId: 'other', name: 'Other App' })]}
        canOpenPage={false}
      />
    );
    // Asserting the SAME testid the hide-when-empty test asserts the absence of,
    // so that negative assertion is known to be about a real, rendered hook.
    await expect.element(page.getByTestId('apps-recent-rail')).toBeInTheDocument();
    await expect
      .element(page.getByRole('heading', { name: 'Recently opened' }))
      .toBeInTheDocument();
    await expect.element(page.getByRole('region', { name: 'Recently opened' })).toBeInTheDocument();
    expect(page.getByTestId('apps-recent-rail-item').elements()).toHaveLength(2);
    await expect.element(page.getByText('Gen Matrix')).toBeInTheDocument();
    await expect.element(page.getByText('Other App')).toBeInTheDocument();
  });

  test('an on-site page app re-opens at /apps/run/<blockId> when the pages flag is lit', async () => {
    renderWithProviders(<RecentlyOpenedListingsView entries={[onsite()]} canOpenPage />);
    await expect
      .element(page.getByTestId('apps-recent-rail-item'))
      .toHaveAttribute('href', '/apps/run/gen-matrix');
  });

  test('with the pages flag DARK it falls back to the detail (never a 404 run link)', async () => {
    renderWithProviders(<RecentlyOpenedListingsView entries={[onsite()]} canOpenPage={false} />);
    await expect
      .element(page.getByTestId('apps-recent-rail-item'))
      .toHaveAttribute('href', '/apps/store-preview/gen-matrix');
  });

  test('an off-site entry links out as a hardened new-tab anchor', async () => {
    renderWithProviders(
      <RecentlyOpenedListingsView
        entries={[
          {
            id: 'lst_1',
            slug: 'ext-app',
            kind: 'offsite',
            hasPage: false,
            externalUrl: 'https://ext.example/app',
            name: 'Ext App',
          },
        ]}
        canOpenPage
      />
    );
    const item = page.getByTestId('apps-recent-rail-item');
    await expect.element(item).toHaveAttribute('href', 'https://ext.example/app');
    await expect.element(item).toHaveAttribute('target', '_blank');
    await expect.element(item).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
