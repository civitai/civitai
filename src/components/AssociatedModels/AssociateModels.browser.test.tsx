import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The "Manage Suggested Resources" modal, and the one thing about it that destroys data.
 *
 * `setAssociatedResources` is a SET-REPLACE: the server deletes every saved association whose
 * id is absent from the payload. The modal's local list is seeded from the associations query,
 * so if a row can be added to that list before the query resolves, the list is a partial view
 * of the saved set and saving deletes the rest — silently, with no undo.
 *
 * The guard is that the search dropdown does not render until the saved list has been
 * delivered. The absence assertion alone would pass for a component that failed to render at
 * all, so it is anchored twice: by an awaited control inside the same test, and by a separate
 * test that the same stub DOES appear once the query resolves.
 */

const STUB_SELECT_LABEL = 'stub search select';

const { queryState, mutate, capturedMutationInput } = vi.hoisted(() => ({
  // Every field a fixture sets is read by a guard in the component. Keep them explicit: a
  // fixture that omits one makes the guard reading it pass for want of a value rather than for
  // the reason it exists, and the obvious later tidy — filling the shape in — un-fixes it.
  queryState: {
    value: undefined as unknown as QueryFixture,
  },
  mutate: vi.fn(),
  capturedMutationInput: { value: undefined as unknown },
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, username: 'owner' }),
}));
vi.mock('~/utils/notifications', () => ({
  showWarningNotification: vi.fn(),
  showErrorNotification: vi.fn(),
  showSuccessNotification: vi.fn(),
}));

// The real dropdown owns a Meilisearch client and an InstantSearch tree; none of that is what
// is under test. The stub is a button that commits a selection, which is the only capability
// the guard is there to withhold.
vi.mock('~/components/Search/QuickSearchDropdown', () => ({
  QuickSearchDropdown: ({
    onItemSelected,
  }: {
    onItemSelected: (item: unknown, data: unknown) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onItemSelected(
          { entityType: 'Model', entityId: 300 },
          {
            id: 300,
            name: 'Freshly picked',
            type: 'Checkpoint',
            nsfwLevel: 1,
            user: { id: 1, username: 'owner' },
          }
        )
      }
    >
      {STUB_SELECT_LABEL}
    </button>
  ),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({
      model: {
        getAssociatedResourcesSimple: { invalidate: vi.fn() },
        getAssociatedResourcesCardData: { invalidate: vi.fn() },
      },
    }),
    model: {
      getAssociatedResourcesSimple: {
        // Returns the fixture object itself, so `data` is reference-stable across renders the way
        // React Query's structural sharing makes it in the app. Do not rebuild it per call: the
        // seeding effect depends on that array's identity, and a fresh one each render is an
        // unbounded setState loop — a pure microtask spin the runner reports as neither a failure
        // nor a timeout.
        useQuery: () => queryState.value,
      },
      setAssociatedResources: {
        useMutation: () => ({
          mutate: (input: unknown) => {
            capturedMutationInput.value = input;
            mutate(input);
          },
          isPending: false,
        }),
      },
    },
  },
}));

import { AssociateModels } from '~/components/AssociatedModels/AssociateModels';

const savedRows = [
  {
    id: 11,
    resourceType: 'model' as const,
    item: {
      id: 101,
      name: 'Saved one',
      type: 'Checkpoint',
      nsfwLevel: 1,
      user: { id: 1, username: 'owner' },
    },
  },
  {
    id: 12,
    resourceType: 'model' as const,
    item: {
      id: 102,
      name: 'Saved two',
      type: 'LORA',
      nsfwLevel: 1,
      user: { id: 1, username: 'owner' },
    },
  },
];

type QueryFixture = {
  data?: typeof savedRows;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  isSuccess: boolean;
};

/** Never resolves — the loading state has to be absorbing, or the assertion races a real load. */
const pending: QueryFixture = {
  data: undefined,
  isLoading: true,
  isFetching: true,
  isError: false,
  isSuccess: false,
};
const resolved: QueryFixture = {
  data: savedRows,
  isLoading: false,
  isFetching: false,
  isError: false,
  isSuccess: true,
};
/** Settled with nothing delivered: the saved list is unknown, so it is not safe to edit. */
const failed: QueryFixture = {
  data: undefined,
  isLoading: false,
  isFetching: false,
  isError: true,
  isSuccess: false,
};
/** Rows on screen, a correction still in flight — the list shown may not be the saved one. */
const refetching: QueryFixture = {
  data: savedRows,
  isLoading: false,
  isFetching: true,
  isError: false,
  isSuccess: true,
};
/** A background refetch failed. The rows are still the delivered ones; only the status moved. */
const refetchFailed: QueryFixture = {
  data: savedRows,
  isLoading: false,
  isFetching: false,
  isError: true,
  isSuccess: false,
};
/**
 * What a stale cache looks like once it is corrected: the third row is an association saved in
 * an earlier edit that the cached copy did not know about.
 */
const lateRow = {
  id: 13,
  resourceType: 'model' as const,
  item: {
    id: 103,
    name: 'Saved in the edit before this one',
    type: 'LORA',
    nsfwLevel: 1,
    user: { id: 1, username: 'owner' },
  },
};
const resolvedCorrected: QueryFixture = {
  data: [...savedRows, lateRow],
  isLoading: false,
  isFetching: false,
  isError: false,
  isSuccess: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  queryState.value = resolved;
  capturedMutationInput.value = undefined;
});

const renderModal = () =>
  renderWithProviders(<AssociateModels fromId={5} type="Suggested" ownerId={1} />);

describe('AssociateModels — the search dropdown waits for the saved list', () => {
  test('is not rendered while the associations query is still in flight', async () => {
    queryState.value = pending;
    renderModal();

    // Positive control for the assertion below: the component DID render, it is just loading.
    // Without this, an early throw or an unmounted fixture would satisfy the absence check.
    // Save Changes is returned from the SAME render as the dropdown, which is what makes it a
    // valid ordering anchor — if the dropdown ever becomes gated on post-commit state instead,
    // this test goes vacuous silently and the anchor has to move with it.
    await expect.element(page.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();

    // Read synchronously rather than with `expect.element().not.*`. The anchor above has already
    // awaited a committed render, so there is nothing left to poll for — and an awaited absence
    // matcher spends the whole 15s budget before reporting a present element, which turns a
    // caught regression into a run that reads like a hang.
    expect(
      page.getByRole('button', { name: STUB_SELECT_LABEL }).query(),
      'search dropdown'
    ).toBeNull();
  });

  test('is not rendered, and the failure is named, when the query delivers nothing', async () => {
    queryState.value = failed;
    renderModal();

    // Same anchor-then-read-synchronously shape as the in-flight test, and for the same reason:
    // all three of these come from one render, so awaiting each in turn would only spend the 15s
    // budget on whichever one a regression removed.
    await expect.element(page.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();

    // Labelled: four null-shaped assertions in this file would otherwise report the same header.
    expect(
      page.getByText(/Couldn't load this model's suggested resources/i).query(),
      'failure copy'
    ).not.toBeNull();
    expect(
      page.getByRole('button', { name: STUB_SELECT_LABEL }).query(),
      'search dropdown'
    ).toBeNull();
    // The bug this replaces: a failed query fell through to the empty-state copy, telling the
    // creator their model has no suggested resources and to search above for a box that the
    // guard had just removed.
    expect(page.getByText(/search above to add one/i).query(), 'empty-state copy').toBeNull();
  });

  test('is rendered once the associations query resolves', async () => {
    renderModal();

    await expect.element(page.getByRole('button', { name: STUB_SELECT_LABEL })).toBeInTheDocument();
  });

  test('is still rendered when a BACKGROUND refetch fails and the rows are intact', async () => {
    // The whole reason the predicate is delivery rather than `isSuccess`. A failed background
    // refetch keeps the delivered rows and only moves the status, so the list on screen is the
    // saved one and editing it is safe. Gating on `isSuccess` here would yank the search box out
    // from under an open edit. This test is also what stops a future tidy-up of the fixtures from
    // quietly making an `isSuccess` gate look correct again.
    queryState.value = refetchFailed;
    renderModal();

    await expect.element(page.getByRole('button', { name: STUB_SELECT_LABEL })).toBeInTheDocument();
  });

  test('is not rendered while a correction to the saved list is still in flight', async () => {
    // Rows are on screen but they may not be the saved set: a save whose invalidate found no
    // active observer leaves the cache stale, and the reopen refetches. An edit started here sets
    // `changed`, the seeding effect below then refuses the correction, and the set-replace deletes
    // the row this modal never saw. Same destruction as the in-flight case, one layer out.
    queryState.value = refetching;
    renderModal();

    // Anchored on a row rather than on the Save button: this proves the list HAS rendered, which
    // is what makes the dropdown's absence attributable to the guard rather than to an empty view.
    await expect.element(page.getByText('Saved two')).toBeInTheDocument();

    expect(
      page.getByRole('button', { name: STUB_SELECT_LABEL }).query(),
      'search dropdown'
    ).toBeNull();
  });

  test('saving after an add keeps every saved association in the payload', async () => {
    // Start pending so the local list is genuinely empty at mount and has to be seeded by the
    // effect when the data lands. Rendering straight into the resolved state would seed the
    // list from `useState(data)` instead, and the test would pass with the effect deleted.
    queryState.value = pending;
    const { rerender } = await renderModal();

    queryState.value = resolved;
    await rerender(<AssociateModels fromId={5} type="Suggested" ownerId={1} />);

    await page.getByRole('button', { name: STUB_SELECT_LABEL }).click();
    await page.getByRole('button', { name: 'Save Changes' }).click();

    expect(mutate).toHaveBeenCalledTimes(1);
    const input = capturedMutationInput.value as {
      associations: Array<{ id?: number; resourceId: number }>;
    };
    expect(input.associations).toEqual([
      { id: 11, resourceType: 'model', resourceId: 101 },
      { id: 12, resourceType: 'model', resourceId: 102 },
      { id: undefined, resourceType: 'model', resourceId: 300 },
    ]);
  });

  /**
   * The sibling defect, and the reason the seeding effect is gated on `changed` rather than on
   * the local list being empty. Reachable without any of this modal's in-flight window: close it
   * before a save's mutation resolves, and `invalidate`'s default `refetchType: 'active'` finds
   * no observer, so the next open snapshots the pre-save cache and the refetch lands afterwards.
   * Seeding only-when-empty refuses that correction, and the next save deletes the row it never
   * saw. Do not narrow this back to `!associatedResources.length` — that is the bug.
   */
  test('adopts a corrected saved list that arrives after the first, stale one', async () => {
    const { rerender } = await renderModal();

    await expect.element(page.getByText('Saved two')).toBeInTheDocument();

    queryState.value = resolvedCorrected;
    await rerender(<AssociateModels fromId={5} type="Suggested" ownerId={1} />);

    // Await the corrected row rather than inferring it from the payload: `rerender` yields
    // microtasks while React schedules the seeding effect on a macrotask, so without this the
    // test leans on `.click()` burning enough real time. The corrected fixture is static, so
    // this state is absorbing and awaiting its arrival is safe.
    await expect.element(page.getByText('Saved in the edit before this one')).toBeInTheDocument();

    await page.getByRole('button', { name: STUB_SELECT_LABEL }).click();
    await page.getByRole('button', { name: 'Save Changes' }).click();

    expect(mutate).toHaveBeenCalledTimes(1);
    const input = capturedMutationInput.value as {
      associations: Array<{ id?: number; resourceId: number }>;
    };
    expect(input.associations).toEqual([
      { id: 11, resourceType: 'model', resourceId: 101 },
      { id: 12, resourceType: 'model', resourceId: 102 },
      { id: 13, resourceType: 'model', resourceId: 103 },
      { id: undefined, resourceType: 'model', resourceId: 300 },
    ]);
  });

  /**
   * THE DELIBERATE TRADEOFF, pinned so it is not read as an oversight and quietly "fixed".
   *
   * When a correction lands on top of work the user has already done, the edit wins and the
   * correction is dropped — so the payload below does NOT carry id 13, and saving it would delete
   * that row. Clobbering the edit instead is worse: it discards work the user can see, silently.
   * What makes the tradeoff acceptable is that the app does not let the user reach this state —
   * the dropdown is withheld while `isFetching`, so an edit cannot begin during a correction. If
   * you remove that gate, this becomes reachable and this test is the one that says so.
   */
  test('keeps the in-progress edit, and drops the correction, when both arrive', async () => {
    const { rerender } = await renderModal();

    await page.getByRole('button', { name: STUB_SELECT_LABEL }).click();

    queryState.value = resolvedCorrected;
    await rerender(<AssociateModels fromId={5} type="Suggested" ownerId={1} />);

    await page.getByRole('button', { name: 'Save Changes' }).click();

    const input = capturedMutationInput.value as {
      associations: Array<{ id?: number; resourceId: number }>;
    };
    expect(input.associations).toEqual([
      { id: 11, resourceType: 'model', resourceId: 101 },
      { id: 12, resourceType: 'model', resourceId: 102 },
      { id: undefined, resourceType: 'model', resourceId: 300 },
    ]);
  });
});
