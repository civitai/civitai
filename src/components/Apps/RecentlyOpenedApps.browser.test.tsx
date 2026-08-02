import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
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

  /**
   * The tile's ICON CTA. Added alongside the tile link, which meant restructuring
   * the tile: it used to be ONE big `<Anchor>` wrapping the card, and nesting a
   * button or a second anchor inside an `<a>` is invalid HTML (the parser
   * reparents it, breaking keyboard order and screen-reader announcement). It is
   * now a `Card` positioning context + a stretched link overlay + a SIBLING
   * `ActionIcon`. These tests pin the properties that restructure had to preserve.
   */
  describe('the icon CTA', () => {
    /**
     * 🔴 SWALLOW THE NAVIGATION. Both targets are REAL anchors with real hrefs
     * and `next/link` degrades to a plain anchor outside a Next app, so a
     * `userEvent.click` here actually navigates the test iframe to
     * `/apps/run/gen-matrix`. Vitest then loses the iframe and the whole FILE
     * dies with "Cannot connect to the iframe" — taking every later test with it
     * and reporting them as failures that have nothing to do with the code.
     * A capture-phase `preventDefault` cancels the default action while leaving
     * the component's own handlers to run, which is exactly what is under test.
     */
    const swallowNavigation = (e: Event) => e.preventDefault();
    beforeEach(() => document.addEventListener('click', swallowNavigation, true));
    afterEach(() => document.removeEventListener('click', swallowNavigation, true));

    test('is reachable and carries a REAL accessible name (not just a glyph)', async () => {
      renderWithProviders(<RecentlyOpenedListingsView entries={[onsite()]} canOpenPage />);
      // Named per-app, so a screen-reader user tabbing a six-tile rail hears which
      // app each button belongs to rather than six identical "Open"s.
      await expect
        .element(page.getByRole('link', { name: 'Open Gen Matrix' }))
        .toBeInTheDocument();
    });

    test('the two targets are SIBLINGS, not nested — no <a> inside an <a>', async () => {
      renderWithProviders(<RecentlyOpenedListingsView entries={[onsite()]} canOpenPage />);
      // Await FIRST: `render()` commits on a later task, so a synchronous
      // `.element()` observes an empty container and throws (or, for a negative
      // assertion, passes vacuously). Same trap as the RENDER_BARRIER note above.
      await expect.element(page.getByTestId('apps-recent-rail-action')).toBeInTheDocument();
      const tileLink = page.getByTestId('apps-recent-rail-item').element();
      const actionLink = page.getByTestId('apps-recent-rail-action').element();
      // The exact thing the restructure exists to prevent. `contains` is true for
      // an element and itself, so this also rejects "they are the same element".
      expect(tileLink.contains(actionLink)).toBe(false);
      expect(actionLink.contains(tileLink)).toBe(false);
      // Neither may have an <a> ancestor other than itself.
      expect(actionLink.parentElement?.closest('a')).toBeNull();
      expect(tileLink.parentElement?.closest('a')).toBeNull();
    });

    test('KEYBOARD TAB ORDER reaches both, tile link first', async () => {
      renderWithProviders(<RecentlyOpenedListingsView entries={[onsite()]} canOpenPage />);
      await expect.element(page.getByTestId('apps-recent-rail-action')).toBeInTheDocument();
      const tileLink = page.getByTestId('apps-recent-rail-item').element() as HTMLElement;
      const actionLink = page.getByTestId('apps-recent-rail-action').element() as HTMLElement;
      // Document order IS tab order here: both are natively-focusable anchors with
      // no tabindex, so nothing reorders them.
      expect(tileLink.getAttribute('tabindex')).toBeNull();
      expect(actionLink.getAttribute('tabindex')).toBeNull();
      expect(
        tileLink.compareDocumentPosition(actionLink) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      // …and both really take focus.
      tileLink.focus();
      expect(document.activeElement).toBe(tileLink);
      actionLink.focus();
      expect(document.activeElement).toBe(actionLink);
    });

    test('clicking the icon records the open ONCE — it does not also fire the tile link', async () => {
      const onOpenRecent = vi.fn();
      renderWithProviders(
        <RecentlyOpenedListingsView entries={[onsite()]} canOpenPage onOpenRecent={onOpenRecent} />
      );
      await userEvent.click(page.getByTestId('apps-recent-rail-action'));
      // Exactly one: the icon sits ABOVE the stretched overlay (z-index), so the
      // overlay never sees the click. Two calls would mean a double navigation.
      expect(onOpenRecent).toHaveBeenCalledTimes(1);
      expect(onOpenRecent).toHaveBeenCalledWith(expect.objectContaining({ id: 'ab_1' }));
    });

    test('clicking the TILE still records the open (the off-site one-shot path)', async () => {
      const onOpenRecent = vi.fn();
      renderWithProviders(
        <RecentlyOpenedListingsView entries={[onsite()]} canOpenPage onOpenRecent={onOpenRecent} />
      );
      await userEvent.click(page.getByTestId('apps-recent-rail-item'));
      expect(onOpenRecent).toHaveBeenCalledTimes(1);
    });

    test('the icon and the tile point at the SAME target (the icon cannot drift)', async () => {
      renderWithProviders(<RecentlyOpenedListingsView entries={[onsite()]} canOpenPage />);
      await expect.element(page.getByTestId('apps-recent-rail-item')).toBeInTheDocument();
      const href = page.getByTestId('apps-recent-rail-item').element().getAttribute('href');
      await expect.element(page.getByTestId('apps-recent-rail-action')).toHaveAttribute(
        'href',
        href as string
      );
    });

    test('the ACTION matches the destination: run → Open, detail → View details, external → Visit', async () => {
      // A play glyph labelled "Open" pointing at a detail page would be a lie in
      // the accessible name, not just a cosmetic mismatch — hence deriving both
      // from the same `getRecentRailTarget` decision.
      const { rerender } = await renderWithProviders(
        <RecentlyOpenedListingsView entries={[onsite()]} canOpenPage />
      );
      await expect.element(page.getByRole('link', { name: 'Open Gen Matrix' })).toBeInTheDocument();

      await rerender(<RecentlyOpenedListingsView entries={[onsite()]} canOpenPage={false} />);
      await expect
        .element(page.getByRole('link', { name: 'View details for Gen Matrix' }))
        .toBeInTheDocument();

      await rerender(
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
      await expect.element(page.getByRole('link', { name: 'Visit Ext App' })).toBeInTheDocument();
    });
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
