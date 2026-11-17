import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
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

const { RecentlyOpenedAppsView } = await import('./RecentlyOpenedApps');

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
    coverUrl: null,
  };
}

const emptyMaps = {
  subsByBlock: new Map(),
};

/**
 * 🔴 RENDER BARRIER — required for every "this is NOT in the document" assertion
 * here.
 *
 * `render()` mounts through a React 18 concurrent root, so the DOM is committed
 * on a later task, not synchronously. A bare `expect(locator.elements())
 * .toHaveLength(0)` straight after `render()` therefore observes an EMPTY
 * container and passes no matter what the component does — it is structurally
 * unfailable (verified by mutation: deleting the component's empty-list
 * early-return did not turn it red).
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
      <RecentlyOpenedAppsView blocks={blocks} onOpen={vi.fn()} canOpenPage={false} {...emptyMaps} />
    );
    await expect
      .element(page.getByRole('heading', { name: 'Recently opened' }))
      .toBeInTheDocument();
    // The section is exposed as a labelled region.
    await expect.element(page.getByRole('region', { name: 'Recently opened' })).toBeInTheDocument();
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
