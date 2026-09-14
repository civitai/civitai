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
 * The guard is that the search dropdown does not render until the query has resolved. These
 * tests are written as a pair on purpose: the absence assertion alone would pass for a
 * component that failed to render at all, so it is anchored by a test that the same stub DOES
 * appear once the query succeeds, and by the loader assertion beside it.
 */

const STUB_SELECT_LABEL = 'stub search select';

const { queryState, mutate, capturedMutationInput } = vi.hoisted(() => ({
  queryState: {
    value: {} as { data?: unknown[]; isLoading: boolean; isSuccess: boolean },
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
const pending = { data: undefined, isLoading: true, isSuccess: false };
const resolved = { data: savedRows, isLoading: false, isSuccess: true };

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
    await expect.element(page.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();

    // Read synchronously rather than with `expect.element().not.*`. The positive control above
    // has already awaited a committed render, so there is nothing left to poll for — and an
    // awaited absence matcher spends the whole 15s budget before reporting a present element,
    // which turns a caught regression into a run that reads like a hang.
    expect(page.getByRole('button', { name: STUB_SELECT_LABEL }).query()).toBeNull();
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
});
