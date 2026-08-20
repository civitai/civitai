import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as MantineHooks from '@mantine/hooks';
import type { MyAppRow } from '~/components/Apps/myAppsView';
import type * as TrpcModule from '~/utils/trpc';
import { capabilitiesForKind } from '~/shared/constants/app-capabilities.constants';
import {
  EDITOR_ACTIONS,
  OWNER_ACTIONS_BY_STATE,
  sortAuthorActions,
} from '~/components/Apps/myAppsAuthorActions';

/**
 * THE AUTHOR-ACTION LEDGER for `/apps/mine`, and the restored Unpublish / Republish pair.
 *
 * 🔴 WHY THIS FILE EXISTS, AND WHY IT IS NOT JUST "TESTS FOR THE FIX". PR #4154 consolidated
 * `/apps/my-submissions` into `/apps/mine`. `MySubmissionsList` — the only surface carrying
 * the owner Unpublish/Republish controls — was orphaned by that merge, and the new page body
 * contained zero occurrences of `unpublish`. The gap was DISCLOSED in the implementing PR and
 * recorded as a noted omission rather than as a functional regression, and then THREE audit
 * rounds passed over it. Each round asked "is the new page correct?"; none asked "is it
 * COMPLETE?" — and no per-assertion suite can answer the second question, because a control
 * that is simply absent has nothing to assert against. A tester found it instead.
 *
 * So the instrument here is a LEDGER, not another assertion:
 *
 *   `renderedActions()` enumerates EVERY interactive control inside a row's action container
 *   and compares the resulting SET against `OWNER_ACTIONS_BY_STATE` / `EDITOR_ACTIONS`. It
 *   fails when the set SHRINKS (a control was dropped — the #4154 shape) and when it GROWS
 *   (a control was added without being declared). It additionally REFUSES a control that
 *   carries no `data-author-action`, so "grew" cannot be evaded by omitting the attribute.
 *
 * 🔴 THE LEDGER ALONE IS NOT ENOUGH, and the second half is deliberate. A structural set
 * comparison type-checks straight past a button wired to the wrong procedure, or to none —
 * both of which render an identical DOM. `describe('the wiring')` therefore drives each
 * control for real and asserts the exact procedure and the exact input.
 *
 * 🔴 RED-AT-BASE, STATED PRECISELY AND MEASURED. Against a tree whose `RowActions` renders
 * only the History toggle — which is exactly what `origin/main`'s `MyAppsBody` offers an
 * author — this file is **8 failed / 3 passed**, and the two distinct assertion messages are
 * `expected [ 'history' ] to deeply equal [ 'unpublish', 'history' ]` and
 * `… to deeply equal [ 'republish', 'history' ]`. That is a BEHAVIOURAL red on the ledger's
 * own assertions. It is stated that way rather than as "checked out `origin/main`" because a
 * literal checkout of the base component fails on a missing export instead, which would be a
 * much weaker claim. The three that still pass are the mod-removed, draft and collaborator
 * cases — correctly, since `['history']` is their right answer either way.
 *
 * The `sortAuthorActions` / vocabulary guards in `__tests__/myAppsAuthorActions.test.ts` are
 * NEW-BEHAVIOUR guards and are labelled as such there — nothing on `main` could have violated
 * them.
 *
 * 🔴 WHAT IS MOCK-SHADOWED. The data layer entirely. The `component` project loads no CSS, so
 * nothing here is a claim about layout — only about which controls exist and what they call.
 */

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[],
  /** `[procedureName, input]` for every mutation fired, in order. */
  calls: [] as Array<[string, unknown]>,
  republishPending: false,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true }),
}));

/** One mutation stub that RECORDS which procedure it belongs to — see `the wiring` below. */
function mutationStub(name: string, isPending = false) {
  return {
    useMutation: () => ({
      mutate: (input: unknown) => mocks.calls.push([name, input]),
      isPending,
    }),
  };
}

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({
      appListings: {
        listingHistory: { invalidate: vi.fn() },
        listMine: { invalidate: vi.fn() },
        listMyOrphanedSubmissions: { invalidate: vi.fn() },
      },
    }),
    appListings: {
      listMine: { useQuery: () => ({ data: mocks.rows, isLoading: false, error: null }) },
      listingHistory: { useQuery: () => ({ data: [], isLoading: false, error: null }) },
      listMyOrphanedSubmissions: {
        useQuery: () => ({ data: [], isLoading: false, error: null }),
      },
      withdrawExternalRequest: mutationStub('withdrawExternalRequest'),
      // 🔴 The two procedures under test are stubbed with DISTINCT recorded names, so an
      // assertion cannot pass by hitting the wrong one. `unpublishOwnListing` is consumed
      // inside `OwnerUnpublishModal`, which is why the confirm click has to be driven for
      // real rather than the mutation called directly.
      unpublishOwnListing: mutationStub('unpublishOwnListing'),
      get republishOwnListing() {
        return mutationStub('republishOwnListing', mocks.republishPending);
      },
      listMyListingModerationEvents: {
        useQuery: () => ({ data: { items: [] }, isLoading: false, error: null }),
      },
    },
    blocks: { withdrawPublishRequest: mutationStub('withdrawPublishRequest') },
  },
}));

vi.mock('@mantine/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof MantineHooks>()),
  useMediaQuery: () => false,
}));

vi.mock('~/utils/notifications', () => ({
  showErrorNotification: vi.fn(),
  showSuccessNotification: vi.fn(),
}));

const { MyAppsBody, rowActionsTestId } = await import('./MyAppsBody');

/**
 * Fixtures are pairwise distinct on every dimension an assertion names — id, slug, name,
 * status, kind and last moderation action — and none of them can produce an expected value by
 * coincidence. In particular no two rows share a `lastModerationAction`, and `'delist'` is a
 * real moderator action rather than a placeholder, so a mutant that compares against the wrong
 * literal cannot survive on a fixture that could only ever have yielded it.
 */
function row(over: Partial<MyAppRow> & { appListingId: string }): MyAppRow {
  const kind = over.kind ?? 'onsite';
  return {
    slug: `slug-${over.appListingId}`,
    name: `Name ${over.appListingId}`,
    status: 'approved',
    kind,
    appBlockId: kind === 'onsite' ? `ab-${over.appListingId}` : null,
    role: 'owner',
    capabilities: capabilitiesForKind(kind),
    iconUrl: null,
    coverUrl: null,
    lastModerationAction: null,
    updatedAt: '2026-08-01T00:00:00Z',
    ...over,
    ...(over.capabilities ? {} : { capabilities: capabilitiesForKind(over.kind ?? kind) }),
  };
}

const LIVE_ONSITE = row({ appListingId: 'apl_live_on', kind: 'onsite', status: 'approved' });
const LIVE_OFFSITE = row({ appListingId: 'apl_live_off', kind: 'offsite', status: 'approved' });
const OWNER_HIDDEN = row({
  appListingId: 'apl_hidden_q2',
  status: 'removed',
  lastModerationAction: 'owner-unpublish',
});
const MOD_REMOVED = row({
  appListingId: 'apl_modgone_r3',
  status: 'removed',
  lastModerationAction: 'delist',
});
const INACTIVE_DRAFT = row({ appListingId: 'apl_draft_k4', status: 'draft' });
const SEAT_LIVE = row({ appListingId: 'apl_seat_m5', status: 'approved', role: 'editor' });

/**
 * Every interactive control in a row's action container, as declared action ids.
 *
 * 🔴 IT ENUMERATES `button`/`a[href]` AND *THEN* READS THE ATTRIBUTE, in that order. Selecting
 * on `[data-author-action]` directly would make the growth arm inert: a control added without
 * the attribute would simply not be selected, the sets would still match, and the ledger would
 * report clean over a page that had grown a new affordance nobody registered. Throwing on an
 * undeclared control is what closes that.
 */
function renderedActions(appListingId: string): string[] {
  const container = page.getByTestId(rowActionsTestId(appListingId)).element();
  const controls = [...container.querySelectorAll('button, a[href]')];
  const undeclared = controls.filter((c) => !c.getAttribute('data-author-action'));
  if (undeclared.length > 0) {
    throw new Error(
      `${undeclared.length} control(s) in ${rowActionsTestId(appListingId)} carry no ` +
        `data-author-action and are therefore invisible to the ledger: ` +
        undeclared.map((c) => `<${c.tagName.toLowerCase()}>${c.textContent ?? ''}`).join(', ')
    );
  }
  return sortAuthorActions(controls.map((c) => c.getAttribute('data-author-action') as string));
}

/**
 * A `removed` listing lives in the default-collapsed **Inactive** group, so its Republish
 * control is one disclosure click away rather than on the front of the table. Opening it here
 * rather than hiding the fact in a helper: the reachability cost is real and is called out in
 * the PR body as a follow-up, not silently absorbed.
 */
async function openInactive() {
  const toggle = page.getByTestId('apps-mine-inactive-toggle');
  await expect.element(toggle).toBeInTheDocument();
  await userEvent.click(toggle);
}

beforeEach(() => {
  mocks.rows = [];
  mocks.calls = [];
  mocks.republishPending = false;
});

describe('the ledger — the SET of author controls a row offers, per state', () => {
  test('a LIVE (approved) listing offers exactly Unpublish + History', async () => {
    mocks.rows = [LIVE_ONSITE];
    renderWithProviders(<MyAppsBody />);
    await expect
      .element(page.getByTestId(`apps-mine-row-${LIVE_ONSITE.appListingId}`))
      .toBeInTheDocument();

    // 🔴 SET EQUALITY, not `toContain`. `toContain('unpublish')` would pass with Republish
    // wrongly rendered beside it, and would pass with three more controls added silently.
    expect(renderedActions(LIVE_ONSITE.appListingId)).toEqual(
      sortAuthorActions(OWNER_ACTIONS_BY_STATE.live)
    );
    // The literal, restated independently of the table — a mutant that empties
    // `OWNER_ACTIONS_BY_STATE.live` would otherwise make the assertion above trivially true.
    expect(renderedActions(LIVE_ONSITE.appListingId)).toEqual(['unpublish', 'history']);
  });

  test('an OWNER-UNPUBLISHED listing offers exactly Republish + History, and says "unpublished"', async () => {
    mocks.rows = [OWNER_HIDDEN];
    renderWithProviders(<MyAppsBody />);
    await openInactive();
    await expect
      .element(page.getByTestId(`apps-mine-inactive-row-${OWNER_HIDDEN.appListingId}`))
      .toBeInTheDocument();

    expect(renderedActions(OWNER_HIDDEN.appListingId)).toEqual(
      sortAuthorActions(OWNER_ACTIONS_BY_STATE['owner-hidden'])
    );
    expect(renderedActions(OWNER_HIDDEN.appListingId)).toEqual(['republish', 'history']);

    // 🔴 THE BADGE IS PART OF THE AFFORDANCE. `status` reads `removed` for this row and for a
    // moderator takedown alike; the badge is what tells the author which one happened, and
    // therefore why one of them has a button and the other does not.
    await expect
      .element(page.getByTestId(`apps-mine-status-${OWNER_HIDDEN.appListingId}`))
      .toHaveTextContent('unpublished');

    // 🔴 `.query()` — NOT `expect.element(...).not.toBeInTheDocument()`, which is INERT in
    // this repo (issue #4197: it never fails, for any string). Placed AFTER the awaits above
    // so the render has settled; `.query()` is a point-in-time read.
    expect(page.getByTestId(`apps-mine-unpublish-${OWNER_HIDDEN.appListingId}`).query()).toBeNull();
    expect(
      page.getByTestId(`apps-mine-mod-removed-${OWNER_HIDDEN.appListingId}`).query()
    ).toBeNull();
  });

  test('a MODERATOR-REMOVED listing offers NEITHER control, and says why', async () => {
    mocks.rows = [MOD_REMOVED];
    renderWithProviders(<MyAppsBody />);
    await openInactive();
    await expect
      .element(page.getByTestId(`apps-mine-inactive-row-${MOD_REMOVED.appListingId}`))
      .toBeInTheDocument();

    expect(renderedActions(MOD_REMOVED.appListingId)).toEqual(
      sortAuthorActions(OWNER_ACTIONS_BY_STATE['mod-removed'])
    );
    expect(renderedActions(MOD_REMOVED.appListingId)).toEqual(['history']);

    // 🔴 THE LOAD-BEARING ABSENCE. `republishOwnListing` refuses a listing whose last event is
    // a moderator action — "This listing was removed by a moderator and cannot be restored by
    // its owner." A Republish button here could only ever fail.
    expect(page.getByTestId(`apps-mine-republish-${MOD_REMOVED.appListingId}`).query()).toBeNull();
    expect(page.getByTestId(`apps-mine-unpublish-${MOD_REMOVED.appListingId}`).query()).toBeNull();

    // 🔴 THE POSITIVE CONTROL FOR THOSE TWO NULLS. Two `.query()` calls returning null are
    // indistinguishable from a probe wired to nothing — a wrong test-id prefix, a row that
    // never rendered — so something that IS on screen has to be found by the same mechanism.
    expect(
      page.getByTestId(`apps-mine-mod-removed-${MOD_REMOVED.appListingId}`).query()
    ).not.toBeNull();
    await expect
      .element(page.getByTestId(`apps-mine-status-${MOD_REMOVED.appListingId}`))
      .toHaveTextContent('removed by a moderator');
  });

  test('a never-approved (draft) listing offers History only', async () => {
    mocks.rows = [INACTIVE_DRAFT];
    renderWithProviders(<MyAppsBody />);
    await expect
      .element(page.getByTestId(`apps-mine-row-${INACTIVE_DRAFT.appListingId}`))
      .toBeInTheDocument();

    expect(renderedActions(INACTIVE_DRAFT.appListingId)).toEqual(
      sortAuthorActions(OWNER_ACTIONS_BY_STATE.inactive)
    );
    expect(
      page.getByTestId(`apps-mine-unpublish-${INACTIVE_DRAFT.appListingId}`).query()
    ).toBeNull();
  });

  test('a seated COLLABORATOR gets History only on a LIVE app — a seat is not ownership', async () => {
    mocks.rows = [SEAT_LIVE];
    renderWithProviders(<MyAppsBody />);
    await expect
      .element(page.getByTestId(`apps-mine-row-${SEAT_LIVE.appListingId}`))
      .toBeInTheDocument();

    // Same status as LIVE_ONSITE, different role — so this case isolates the ROLE branch.
    expect(renderedActions(SEAT_LIVE.appListingId)).toEqual(sortAuthorActions(EDITOR_ACTIONS));
    expect(page.getByTestId(`apps-mine-unpublish-${SEAT_LIVE.appListingId}`).query()).toBeNull();
  });

  test('every state at once — each row keeps its OWN set', async () => {
    // 🔴 The states are rendered TOGETHER because a per-row derivation that had collapsed into
    // a page-level one would still pass all five single-row cases above. Here it cannot: no
    // single set satisfies four rows at the same time.
    mocks.rows = [LIVE_ONSITE, INACTIVE_DRAFT, OWNER_HIDDEN, MOD_REMOVED];
    renderWithProviders(<MyAppsBody />);
    await openInactive();
    await expect
      .element(page.getByTestId(`apps-mine-inactive-row-${MOD_REMOVED.appListingId}`))
      .toBeInTheDocument();

    expect(renderedActions(LIVE_ONSITE.appListingId)).toEqual(['unpublish', 'history']);
    expect(renderedActions(INACTIVE_DRAFT.appListingId)).toEqual(['history']);
    expect(renderedActions(OWNER_HIDDEN.appListingId)).toEqual(['republish', 'history']);
    expect(renderedActions(MOD_REMOVED.appListingId)).toEqual(['history']);
  });
});

describe('the wiring — each control fires the right procedure with the right input', () => {
  test('Unpublish is CONFIRM-GATED, then calls unpublishOwnListing with the listing id', async () => {
    mocks.rows = [LIVE_ONSITE];
    renderWithProviders(<MyAppsBody />);
    const button = page.getByTestId(`apps-mine-unpublish-${LIVE_ONSITE.appListingId}`);
    await expect.element(button).toBeInTheDocument();

    // 🔴 NOTHING FIRES ON THE FIRST CLICK. An unpublish takes a live app off the store (and,
    // on-site, offline); a control that did it on one click would be a different defect from
    // the one being fixed, not a smaller one.
    await userEvent.click(button);
    expect(mocks.calls).toEqual([]);

    const confirm = page.getByTestId('apps-mine-unpublish-confirm');
    await expect.element(confirm).toBeInTheDocument();
    await userEvent.click(confirm);

    // The WHOLE call list, so a stray call to any other procedure fails here.
    expect(mocks.calls).toEqual([
      ['unpublishOwnListing', { appListingId: 'apl_live_on', reason: undefined }],
    ]);
  });

  test('Republish calls republishOwnListing with the listing id, and needs no confirmation', async () => {
    mocks.rows = [OWNER_HIDDEN];
    renderWithProviders(<MyAppsBody />);
    await openInactive();
    const button = page.getByTestId(`apps-mine-republish-${OWNER_HIDDEN.appListingId}`);
    await expect.element(button).toBeInTheDocument();
    await userEvent.click(button);

    // 🔴 A DIFFERENT ID FROM THE UNPUBLISH CASE, so a mutant that hardcodes either literal
    // fails in one of the two tests. Republish is not confirm-gated on purpose: it restores
    // the previous state, so the recovery from a misclick is the button next to it.
    expect(mocks.calls).toEqual([['republishOwnListing', { appListingId: 'apl_hidden_q2' }]]);
  });

  test('a republish in flight DISABLES the button rather than allowing a second fire', async () => {
    mocks.rows = [OWNER_HIDDEN];
    mocks.republishPending = true;
    renderWithProviders(<MyAppsBody />);
    await openInactive();
    const button = page.getByTestId(`apps-mine-republish-${OWNER_HIDDEN.appListingId}`);
    await expect.element(button).toBeInTheDocument();
    expect(button.element().hasAttribute('disabled')).toBe(true);
  });

  /**
   * 🔴 THE DUAL-KIND TRAP, split into two tests rather than one with an unmount.
   * `/apps/my-submissions` was TWO lists, each passing a FIXED copy variant; `/apps/mine`
   * merges both kinds into one table. A fixed variant here would tell half of all authors
   * something untrue about what the button is about to do — an on-site unpublish takes the
   * app OFFLINE, an off-site one only delists it from the store. Each test asserts its own
   * wording is present AND that the other kind's wording is not, so neither passes by a
   * variant that renders both strings.
   */
  test('an ON-SITE unpublish warns that the app goes OFFLINE', async () => {
    mocks.rows = [LIVE_ONSITE];
    renderWithProviders(<MyAppsBody />);
    await userEvent.click(page.getByTestId(`apps-mine-unpublish-${LIVE_ONSITE.appListingId}`));
    await expect.element(page.getByText(/takes your app OFFLINE/i)).toBeInTheDocument();
    expect(page.getByText(/hides your live app from the store/i).query()).toBeNull();
  });

  test('an OFF-SITE unpublish warns only about the STORE listing', async () => {
    mocks.rows = [LIVE_OFFSITE];
    renderWithProviders(<MyAppsBody />);
    await userEvent.click(page.getByTestId(`apps-mine-unpublish-${LIVE_OFFSITE.appListingId}`));
    await expect.element(page.getByText(/hides your live app from the store/i)).toBeInTheDocument();
    expect(page.getByText(/takes your app OFFLINE/i).query()).toBeNull();
  });
});
