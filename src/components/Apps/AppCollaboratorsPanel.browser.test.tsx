import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { capabilitiesForKind } from '~/shared/constants/app-capabilities.constants';

/**
 * 🔴 THE SEAM BETWEEN THE SCREENING CALL AND THE PICKER.
 *
 * The View's helpers are pure and tested on their own; the service that answers "which of these
 * accounts cannot hold a seat" is tested on its own. Both can be perfectly correct while the
 * container never joins them — the answer arrives and nothing reads it, and every other test in
 * this feature still passes, because none of them loads both surfaces.
 *
 * So these mount the CONTAINER, hand it a screening answer, and assert the answer actually
 * reaches the picker and the selection guard. The real picker is replaced by a stand-in that
 * records the props it was given — the real one resolves a search host at import time and cannot
 * be mounted here at all.
 */

const OWNER_ID = 7001;
const INELIGIBLE_ID = 7002;
const FINE_ID = 7003;

const state = vi.hoisted(() => ({
  /** What the screening query answers with. */
  ineligible: [] as number[],
  /** Ids the picker reported as being on offer. */
  screenedInput: [] as number[],
  /** The listing the screening query was keyed to. */
  screenedListing: null as string | null,
  /** Every `invite` mutation actually fired. */
  inviteCalls: [] as unknown[],
  /** The last `filters` string handed to the picker. */
  pickerFilters: null as string | null,
  /** The picker's `onItemSelected`, so a test can drive a selection. */
  select: null as ((item: unknown, data: unknown) => void) | null,
  /** The picker's `onHits`, so a test can drive what is on offer. */
  reportHits: null as ((ids: number[]) => void) | null,
  /** Whether the screening query was enabled on the last render. */
  screenEnabled: false,
  /** How many times the screening hook ran — the positive control for the assertion below. */
  screenCalls: 0,
}));

/**
 * The panel mounts TWO of these — the invite picker and the ownership-transfer picker. Only the
 * invite one is in frame here, so the stand-in keys on its placeholder; recording both would let
 * the transfer picker's (deliberately unscreened) props answer for the invite picker's.
 */
const INVITE_PLACEHOLDER = 'Search for a community member to invite';

vi.mock('~/components/Search/QuickSearchDropdown', () => ({
  QuickSearchDropdown: (props: any) => {
    const isInvitePicker = props.placeholder === INVITE_PLACEHOLDER;
    if (isInvitePicker) {
      state.pickerFilters = props.filters ?? null;
      state.select = props.onItemSelected ?? null;
      state.reportHits = props.onHits ?? null;
    }
    return <div data-testid={isInvitePicker ? 'stub-invite-picker' : 'stub-other-picker'} />;
  },
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: OWNER_ID }) }));

const { errorNotifications } = vi.hoisted(() => ({ errorNotifications: [] as any[] }));
vi.mock('~/utils/notifications', () => ({
  showErrorNotification: (args: unknown) => errorNotifications.push(args),
  showSuccessNotification: () => undefined,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mutation = (record?: (args: unknown) => void) => ({
    useMutation: () => ({ mutate: (args: unknown) => record?.(args), isPending: false }),
  });
  return {
    ...actual,
    trpc: {
      useUtils: () => ({
        appCollaborators: {
          list: { invalidate: async () => undefined },
          getPendingTransfer: { invalidate: async () => undefined },
        },
      }),
      appCollaborators: {
        list: { useQuery: () => ({ data: [], isLoading: false, error: null }) },
        getPendingTransfer: { useQuery: () => ({ data: null, isLoading: false, error: null }) },
        ineligibleTargets: {
          useQuery: (input: { appListingId: string; userIds: number[] }, opts?: any) => {
            state.screenedInput = input.userIds;
            state.screenedListing = input.appListingId;
            state.screenEnabled = opts?.enabled !== false;
            state.screenCalls += 1;
            return { data: state.ineligible, isLoading: false, error: null };
          },
        },
        invite: mutation((args) => state.inviteCalls.push(args)),
        remove: mutation(),
        setDisplayed: mutation(),
        leave: mutation(),
        initiateTransfer: mutation(),
        cancelTransfer: mutation(),
      },
    },
  };
});

const { AppCollaboratorsPanel } = await import('~/components/Apps/AppCollaboratorsPanel');

const render = (role: 'owner' | 'editor' = 'owner') =>
  renderWithProviders(
    <AppCollaboratorsPanel
      appListingId="apl_seam"
      role={role}
      capabilities={capabilitiesForKind('onsite')}
      listing={{ kind: 'onsite', connectClientId: null }}
    />
  );

beforeEach(() => {
  state.ineligible = [];
  state.screenedInput = [];
  state.screenedListing = null;
  state.screenEnabled = false;
  state.screenCalls = 0;
  state.inviteCalls = [];
  state.pickerFilters = null;
  state.select = null;
  state.reportHits = null;
  errorNotifications.length = 0;
});

describe('AppCollaboratorsPanel — candidate screening reaches the picker', () => {
  test('the picker reports what it is offering, and that is what gets screened', async () => {
    render();
    await expect.element(page.getByTestId('stub-invite-picker')).toBeInTheDocument();

    expect(state.reportHits).not.toBeNull();
    state.reportHits!([FINE_ID, INELIGIBLE_ID]);

    await vi.waitFor(() => {
      expect(state.screenedInput).toEqual([FINE_ID, INELIGIBLE_ID]);
    });
    // Keyed to the listing the proc asserts ownership of — without it the call 400s on the
    // schema and every candidate reads as eligible.
    expect(state.screenedListing).toBe('apl_seam');
  });

  /**
   * 🔴 The proc asserts the caller OWNS the listing, and only an owner is shown the invite
   * picker. An editor issuing it would 403 on every render of a tab they are allowed to see.
   */
  test('an EDITOR does not issue the screening query at all', async () => {
    render('editor');

    // 🔴 ANCHOR ON THE RENDER FIRST. `screenEnabled` starts false, so waiting for it to BE
    // false passes before the component has mounted — a poll that cannot tell "not yet" from
    // "settled". Wait for the panel, prove the hook actually ran, THEN read the flag.
    await expect.element(page.getByTestId('apps-collaborators-panel')).toBeInTheDocument();
    await vi.waitFor(() => expect(state.screenCalls).toBeGreaterThan(0));

    expect(state.screenEnabled).toBe(false);
    // The editor is not shown the invite picker, so there is nothing to screen.
    expect(state.reportHits).toBeNull();
  });

  /** The control arm for the test above — an OWNER does issue it. */
  test('an OWNER does issue the screening query', async () => {
    render();
    await expect.element(page.getByTestId('stub-invite-picker')).toBeInTheDocument();
    // Before any hits are reported the owner's query is idle too — the interesting transition is
    // that reporting hits ENABLES it, which is the opposite of the editor arm above.
    expect(state.screenEnabled).toBe(false);
    state.reportHits!([FINE_ID]);
    await vi.waitFor(() => expect(state.screenEnabled).toBe(true));
  });

  test('an id the server calls ineligible is filtered OUT of the picker', async () => {
    state.ineligible = [INELIGIBLE_ID];
    render();
    await expect.element(page.getByTestId('stub-invite-picker')).toBeInTheDocument();

    await vi.waitFor(() => {
      expect(state.pickerFilters).toContain(`NOT id=${INELIGIBLE_ID}`);
    });
    // The presence half: an empty filter string contains no id at all and would pass the line
    // above only if it were also missing the owner's own exclusion, which it is not.
    expect(state.pickerFilters).toContain(`NOT id=${OWNER_ID}`);
    expect(state.pickerFilters).not.toContain(`NOT id=${FINE_ID}`);
  });

  test('choosing an ineligible candidate does NOT fire the invite', async () => {
    state.ineligible = [INELIGIBLE_ID];
    render();
    await expect.element(page.getByTestId('stub-invite-picker')).toBeInTheDocument();

    await vi.waitFor(() => expect(state.select).not.toBeNull());
    state.select!({}, { id: INELIGIBLE_ID, username: 'someone' });

    await vi.waitFor(() => expect(errorNotifications).toHaveLength(1));
    expect(errorNotifications[0].title).toMatch(/not eligible/i);
    expect(state.inviteCalls).toHaveLength(0);
  });

  /**
   * The control arm. Without it, a container that refuses EVERY selection passes the test above
   * while making the picker useless.
   */
  test('choosing an eligible candidate DOES fire the invite', async () => {
    state.ineligible = [INELIGIBLE_ID];
    render();
    await expect.element(page.getByTestId('stub-invite-picker')).toBeInTheDocument();

    await vi.waitFor(() => expect(state.select).not.toBeNull());
    state.select!({}, { id: FINE_ID, username: 'someone-else' });

    await vi.waitFor(() => expect(state.inviteCalls).toHaveLength(1));
    expect(state.inviteCalls[0]).toEqual({ appListingId: 'apl_seam', targetUserId: FINE_ID });
    expect(errorNotifications).toHaveLength(0);
  });
});
