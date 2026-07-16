import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * AppListingComments — mounts the reusable CommentsV2 stack on an app-listing
 * detail page for the entity type `appListing`, keyed on the listing's INTEGER
 * surrogate (`serialId` = `app_listings.serial_id`), because CommentsV2 is
 * integer-keyed and the listing PK is a TEXT ULID.
 *
 * This pins the integration contract without booting the whole comment stack:
 *   - `RootThreadProvider` (the CommentsProvider entry) is mocked to RECORD the
 *     `entityType`/`entityId` it's mounted with, then render its children so the
 *     component's own "Discussion" wrapper renders. The leaf comment/filter UI is
 *     stubbed to null (hermetic — no tRPC).
 *   - serialId present (an APPROVED listing — `getListingDetail` is approved-only,
 *     so a non-approved listing never yields a serialId-bearing detail to the body)
 *     → the provider is mounted with entityType="appListing" + the integer id, and
 *     the Discussion section renders.
 *   - serialId null/undefined → the whole section renders NOTHING (the provider is
 *     never mounted).
 */

const mocks = vi.hoisted(() => ({
  // Records the props each RootThreadProvider mount received.
  providerMounts: [] as Array<{ entityType: unknown; entityId: unknown }>,
}));

// Mock the CommentsProvider entry point: record the mount props + render children
// with a benign, unlocked/loaded arg set so the component's Discussion wrapper
// renders (leaves are stubbed below, so no network).
vi.mock('~/components/CommentsV2/CommentsProvider', () => ({
  RootThreadProvider: ({
    entityType,
    entityId,
    children,
  }: {
    entityType: unknown;
    entityId: unknown;
    children: (args: Record<string, unknown>) => React.ReactNode;
  }) => {
    mocks.providerMounts.push({ entityType, entityId });
    return (
      <div data-testid="root-thread" data-entity-type={String(entityType)} data-entity-id={String(entityId)}>
        {children({
          data: [],
          created: [],
          isLoading: false,
          isFetching: false,
          isFetchingNextPage: false,
          isLocked: false,
          showMore: false,
          hiddenCount: 0,
          toggleShowMore: () => undefined,
          sort: 'Oldest',
          setSort: () => undefined,
          activeComment: undefined,
        })}
      </div>
    );
  },
}));

// Leaf UI stubbed to null — keeps the render hermetic (they otherwise pull tRPC).
vi.mock('~/components/CommentsV2/Comment/Comment', () => ({ Comment: () => null }));
vi.mock('~/components/CommentsV2/Comment/CreateComment', () => ({ CreateComment: () => null }));
vi.mock('~/components/CommentsV2/ReturnToRootThread', () => ({ ReturnToRootThread: () => null }));
vi.mock('~/components/CommentsV2/HiddenCommentsModal', () => ({ default: () => null }));
vi.mock('~/components/Filters', () => ({ SortFilter: () => null }));
vi.mock('~/components/Dialog/dialogStore', () => ({ dialogStore: { trigger: vi.fn() } }));

import { AppListingComments } from './AppListingComments';

beforeEach(() => {
  mocks.providerMounts.length = 0;
});

describe('AppListingComments', () => {
  test('an approved listing (integer serialId) mounts CommentsProvider with entityType="appListing"', async () => {
    renderWithProviders(<AppListingComments serialId={42} ownerUserId={7} />);

    // The comments section renders…
    await expect.element(page.getByTestId('app-listing-comments')).toBeInTheDocument();
    await expect.element(page.getByText('Discussion')).toBeInTheDocument();

    // …and the provider was mounted keyed on the appListing entity + integer id.
    expect(mocks.providerMounts).toHaveLength(1);
    expect(mocks.providerMounts[0]).toEqual({ entityType: 'appListing', entityId: 42 });

    const node = page.getByTestId('root-thread').element();
    expect(node.getAttribute('data-entity-type')).toBe('appListing');
    expect(node.getAttribute('data-entity-id')).toBe('42');
  });

  test('renders nothing when serialId is null (no surrogate ⇒ no comments surface)', async () => {
    renderWithProviders(<AppListingComments serialId={null} ownerUserId={7} />);
    expect(page.getByTestId('app-listing-comments').query()).toBeNull();
    expect(page.getByTestId('root-thread').query()).toBeNull();
    expect(mocks.providerMounts).toHaveLength(0);
  });

  test('renders nothing when serialId is undefined', async () => {
    renderWithProviders(<AppListingComments serialId={undefined} />);
    expect(page.getByTestId('app-listing-comments').query()).toBeNull();
    expect(page.getByTestId('root-thread').query()).toBeNull();
    expect(mocks.providerMounts).toHaveLength(0);
  });
});
