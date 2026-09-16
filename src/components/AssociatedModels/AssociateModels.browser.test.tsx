import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The "Manage Suggested Resources" modal, and the one thing about it that destroys data.
 *
 * `setAssociatedResources` is a SET-REPLACE: the server deletes every saved association whose id
 * is absent from the payload. So editing a list that is NOT the saved list deletes whatever the
 * shown list does not know about — silently, with no undo. Every guard here serves one invariant:
 * nothing can be committed into the local list unless that list is the saved one.
 *
 * `canEdit` in the component is that question, asked once and used by all four edit affordances.
 * These tests drive it through the query states that make it false, and each is paired with a
 * state where it is true — an absence assertion alone would pass for a component that failed to
 * render at all.
 */

const STUB_SELECT_LABEL = 'stub search select';
const FORCE_SELECT_LABEL = 'stub force select';

type QueryFixture = {
  data?: typeof savedRows;
  isLoading: boolean;
  /**
   * 🔴 `isStale` is the guard's predicate, and the other two flags exist to stop a future
   * "tidy-up" from making a rejected predicate look correct. Read the fixtures below as real
   * React Query v5 results: on a FAILED background refetch the query KEEPS `data`, sets
   * `isError`, and leaves `isSuccess` FALSE. That combination is not a typo — it is the whole
   * reason the gate cannot be `isSuccess`, and "correcting" it would turn an `isSuccess` gate
   * green while it deletes creators' rows.
   */
  isStale: boolean;
  isError: boolean;
  isSuccess: boolean;
  dataUpdatedAt: number;
};

const { queryState, mutate, capturedMutationInput } = vi.hoisted(() => ({
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

// The real dropdown owns a Meilisearch client and an InstantSearch tree; none of that is what is
// under test. Two buttons: one mirroring `disabled` the way the real input does, and one that
// calls `onItemSelected` regardless — the component's own guard has to refuse that, because a
// disabled input is an affordance and not a control.
vi.mock('~/components/Search/QuickSearchDropdown', () => ({
  QuickSearchDropdown: ({
    onItemSelected,
    disabled,
  }: {
    onItemSelected: (item: unknown, data: unknown) => void;
    disabled?: boolean;
  }) => {
    const select = () =>
      onItemSelected(
        { entityType: 'Model', entityId: 300 },
        {
          id: 300,
          name: 'Freshly picked',
          type: 'Checkpoint',
          nsfwLevel: 1,
          user: { id: 1, username: 'owner' },
        }
      );
    return (
      <>
        <button type="button" disabled={disabled} onClick={select}>
          {STUB_SELECT_LABEL}
        </button>
        <button type="button" onClick={select}>
          {FORCE_SELECT_LABEL}
        </button>
      </>
    );
  },
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
        // React Query's structural sharing makes it in the app.
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

/**
 * A row saved in an earlier edit that a stale cache does not know about. It is the row the
 * set-replace deletes if the modal is edited before the correction lands.
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

/** Never resolves — the loading state has to be absorbing, or the assertion races a real load. */
const pending: QueryFixture = {
  data: undefined,
  isLoading: true,
  isStale: true,
  isError: false,
  isSuccess: false,
  dataUpdatedAt: 0,
};
const resolved: QueryFixture = {
  data: savedRows,
  isLoading: false,
  isStale: false,
  isError: false,
  isSuccess: true,
  dataUpdatedAt: 1000,
};
/** Settled with nothing delivered: the saved list is unknown, so it is not safe to edit. */
const failed: QueryFixture = {
  data: undefined,
  isLoading: false,
  isStale: true,
  isError: true,
  isSuccess: false,
  dataUpdatedAt: 0,
};
/** Rows on screen, a correction still in flight: what is shown may not be what is saved. */
const refetching: QueryFixture = {
  data: savedRows,
  isLoading: false,
  isStale: true,
  isError: false,
  isSuccess: true,
  dataUpdatedAt: 1000,
};
/**
 * The correction FAILED. React Query keeps the last SUCCESSFUL payload, so the rows on screen are
 * the pre-correction ones and the query stays invalidated. `isStale` is the only flag that still
 * says so — `isFetching` has gone back to false and `data` looks perfectly healthy.
 */
const refetchFailed: QueryFixture = {
  data: savedRows,
  isLoading: false,
  isStale: true,
  isError: true,
  isSuccess: false,
  dataUpdatedAt: 1000,
};
/**
 * A model with NO saved resources, whose list could not be verified. The empty-state branch has
 * to carry the same explanation the list branch does — otherwise the creator is told to search
 * above, at a box that is greyed out, with nothing saying why.
 */
const emptyUnverified: QueryFixture = {
  data: [],
  isLoading: false,
  isStale: true,
  isError: true,
  isSuccess: false,
  dataUpdatedAt: 1000,
};
const resolvedCorrected: QueryFixture = {
  data: [...savedRows, lateRow],
  isLoading: false,
  isStale: false,
  isError: false,
  isSuccess: true,
  dataUpdatedAt: 2000,
};

beforeEach(() => {
  vi.clearAllMocks();
  queryState.value = resolved;
  capturedMutationInput.value = undefined;
});

const renderModal = () =>
  renderWithProviders(<AssociateModels fromId={5} type="Suggested" ownerId={1} />);

describe('AssociateModels — nothing is editable unless the list is the saved list', () => {
  test('no search dropdown at all while the first load is in flight', async () => {
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
    // The paused notice is gated on the list having been delivered. Without that it renders here
    // too, above the loader, explaining a pause to someone who is waiting for a first load.
    expect(page.getByText(/editing is paused/i).query(), 'paused notice').toBeNull();
  });

  test('no search dropdown, and the failure is named, when the query delivers nothing', async () => {
    queryState.value = failed;
    renderModal();

    await expect.element(page.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();

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
    // And not two contradictory explanations at once: the load failed, so there is no list whose
    // freshness could be in question.
    expect(page.getByText(/editing is paused/i).query(), 'paused notice').toBeNull();
  });

  test('the dropdown is live once the saved list is delivered and current', async () => {
    renderModal();

    const dropdown = page.getByRole('button', { name: STUB_SELECT_LABEL });
    await expect.element(dropdown).toBeInTheDocument();
    expect(dropdown.query()).not.toHaveAttribute('disabled');
    // By LABEL, not by role+name: the SortableItem wrapper is itself `role="button"` and its
    // accessible name CONTAINS the icon's label, so a role query matches the card first and the
    // assertion reads the wrong element.
    expect(page.getByLabelText('Remove resource').first().query()).not.toHaveAttribute(
      'data-disabled'
    );
    expect(
      page.getByText('Saved two').element().closest('[aria-roledescription="sortable"]')
    ).toHaveAttribute('aria-disabled', 'false');
  });

  test('every edit affordance is inert while a correction is in flight', async () => {
    queryState.value = refetching;
    renderModal();

    // Anchored on a ROW: this proves the list branch rendered, which is what makes the disabled
    // affordances attributable to the guard rather than to an empty view.
    await expect.element(page.getByText('Saved two')).toBeInTheDocument();

    // Read synchronously after the awaited anchor: all of these come from the same render, so an
    // awaited matcher would only spend the 15s budget on whichever one a regression un-disabled.
    // Asserted by ATTRIBUTE, not with `toBeDisabled`. Measured: neither the synchronous nor the
    // awaited matcher fails here on an enabled control — `toBeDisabled` reports the row's
    // `aria-disabled` ancestor, so it passes with the button's own prop deleted.
    expect(page.getByRole('button', { name: STUB_SELECT_LABEL }).query()).toHaveAttribute(
      'disabled'
    );
    expect(page.getByLabelText('Remove resource').first().query()).toHaveAttribute(
      'data-disabled',
      'true'
    );
    // Drag is the affordance with no disabled ATTRIBUTE of its own: dnd-kit announces it through
    // `aria-disabled` on the sortable node. Without this the rows stay draggable while every
    // button beside them is greyed out, and a reorder sets `changed` — which is the deletion.
    expect(
      page.getByText('Saved two').element().closest('[aria-roledescription="sortable"]')
    ).toHaveAttribute('aria-disabled', 'true');
    // Assert WHICH notice: both branches of the ternary contain "editing is paused", so a matcher
    // on that phrase alone stays green while an inverted condition tells a user mid-refetch that
    // the check failed.
    expect(
      page.getByText(/Checking this list for changes/i).query(),
      'checking notice'
    ).not.toBeNull();
    expect(
      page.getByText(/Couldn't check whether/i).query(),
      'failure notice must not show'
    ).toBeNull();
  });

  /**
   * The case an earlier revision of this file got BACKWARDS, so read the fixture before changing
   * this test. A failed background refetch leaves `isFetching` false and `data` intact, which
   * looks exactly like a healthy list — but that data is the last SUCCESSFUL payload, and on the
   * reopen-over-an-invalidated-cache route it is the PRE-correction copy. Editing it is the data
   * loss, not the safe case. `isStale` is what still says so.
   */
  test('edits stay inert when the correction failed, because the rows may be pre-correction', async () => {
    queryState.value = refetchFailed;
    renderModal();

    await expect.element(page.getByText('Saved two')).toBeInTheDocument();

    expect(page.getByRole('button', { name: STUB_SELECT_LABEL }).query()).toHaveAttribute(
      'disabled'
    );
    expect(
      page.getByText(/Couldn't check whether this list is up to date/i).query(),
      'could-not-verify notice'
    ).not.toBeNull();
    expect(
      page.getByText(/Checking this list for changes/i).query(),
      'in-flight notice must not show'
    ).toBeNull();
  });

  test('a selection forced past the disabled input still commits nothing', async () => {
    queryState.value = refetching;
    renderModal();

    await expect.element(page.getByText('Saved two')).toBeInTheDocument();
    await page.getByRole('button', { name: FORCE_SELECT_LABEL }).click();

    // Deliberately NOT asserting Save is disabled: it is gated on `!changed || !canEdit`, and
    // `canEdit` is false in this fixture, so that assertion would hold whether or not the handler
    // refused anything. The two below are what discriminate — the row never entered the list, and
    // nothing was sent.
    expect(page.getByText('Freshly picked').query(), 'forced row').toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });

  test('an unverified EMPTY list explains itself instead of pointing at a dead search box', async () => {
    queryState.value = emptyUnverified;
    renderModal();

    await expect.element(page.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();

    expect(page.getByText(/No suggested resources yet/i).query(), 'empty copy').not.toBeNull();
    expect(
      page.getByText(/search above to add one/i).query(),
      'the instruction that would be a lie here'
    ).toBeNull();
    expect(
      page.getByText(/Couldn't check whether this list is up to date/i).query(),
      'could-not-verify notice'
    ).not.toBeNull();
    expect(page.getByRole('button', { name: STUB_SELECT_LABEL }).query()).toHaveAttribute(
      'disabled'
    );
  });

  test('saving after an add keeps every saved association in the payload', async () => {
    // Start pending so the local list is genuinely empty at mount and has to be seeded by the
    // effect when the data lands. Rendering straight into the resolved state would seed the list
    // from `useState(data)` instead, and the test would pass with the effect deleted.
    queryState.value = pending;
    const { rerender } = await renderModal();

    queryState.value = resolved;
    await rerender(<AssociateModels fromId={5} type="Suggested" ownerId={1} />);

    await page.getByRole('button', { name: STUB_SELECT_LABEL }).click();
    await page.getByRole('button', { name: 'Save Changes' }).click();

    expect(mutate).toHaveBeenCalledTimes(1);
    const input = capturedMutationInput.value as {
      associations: Array<{ id?: number; resourceId: number }>;
      reciprocal: number[];
    };
    expect(input.associations).toEqual([
      { id: 11, resourceType: 'model', resourceId: 101 },
      { id: 12, resourceType: 'model', resourceId: 102 },
      { id: undefined, resourceType: 'model', resourceId: 300 },
    ]);
    // The added row IS link-back eligible here (newly added, owned by `ownerId`), so the chip is
    // rendered. An unticked chip must send nothing: `reciprocal` writes a link on someone else's
    // model, and it is not something a save should opt into on the creator's behalf.
    expect(input.reciprocal, 'reciprocal').toEqual([]);
  });

  test('adopts a corrected saved list that arrives after the first, stale one', async () => {
    const { rerender } = await renderModal();

    await expect.element(page.getByText('Saved two')).toBeInTheDocument();

    queryState.value = resolvedCorrected;
    await rerender(<AssociateModels fromId={5} type="Suggested" ownerId={1} />);

    // Await the corrected row rather than inferring it from the payload: `rerender` yields
    // microtasks while React schedules the seeding effect on a macrotask, so without this the
    // test leans on `.click()` burning enough real time. The corrected fixture is static, so this
    // state is absorbing and awaiting its arrival is safe.
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
   *
   * What makes the tradeoff acceptable is that the app does not let the user reach this state:
   * `canEdit` is false for every affordance while the list is stale, so no edit can be in progress
   * when a correction arrives. THIS test constructs the state directly and does not exercise that
   * guard at all — the tests holding that line are the two inert-affordance ones above. Remove
   * `canEdit` and those go red, not this one.
   */
  test('keeps the in-progress edit, and drops the correction, when both arrive', async () => {
    const { rerender } = await renderModal();

    await page.getByRole('button', { name: STUB_SELECT_LABEL }).click();

    queryState.value = resolvedCorrected;
    await rerender(<AssociateModels fromId={5} type="Suggested" ownerId={1} />);

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
