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
  queryState: {
    value: {} as { data?: unknown[]; isLoading: boolean },
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

/** Never resolves — the loading state has to be absorbing, or the assertion races a real load. */
const pending = { data: undefined, isLoading: true };
const resolved = { data: savedRows, isLoading: false };
/** Settled with nothing delivered: the saved list is unknown, so it is not safe to edit. */
const failed = { data: undefined, isLoading: false };
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
const resolvedCorrected = { data: [...savedRows, lateRow], isLoading: false };

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
    expect(page.getByRole('button', { name: STUB_SELECT_LABEL }).query()).toBeNull();
  });

  test('is not rendered, and the failure is named, when the query delivers nothing', async () => {
    queryState.value = failed;
    renderModal();

    // Same anchor-then-read-synchronously shape as the in-flight test, and for the same reason:
    // all three of these come from one render, so awaiting each in turn would only spend the 15s
    // budget on whichever one a regression removed.
    await expect.element(page.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();

    expect(
      page.getByText(/Couldn't load this model's suggested resources/i).query()
    ).not.toBeNull();
    expect(page.getByRole('button', { name: STUB_SELECT_LABEL }).query()).toBeNull();
    // The bug this replaces: a failed query fell through to the empty-state copy, telling the
    // creator their model has no suggested resources and to search above for a box that the
    // guard had just removed.
    expect(page.getByText(/search above to add one/i).query()).toBeNull();
  });

  test('is rendered once the associations query resolves', async () => {
    renderModal();

    await expect.element(page.getByRole('button', { name: STUB_SELECT_LABEL })).toBeInTheDocument();
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
});
