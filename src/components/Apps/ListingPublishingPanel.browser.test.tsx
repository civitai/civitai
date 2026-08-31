import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';
import {
  EDITOR_ACTIONS,
  OWNER_ACTIONS_BY_STATE,
  sortPublishingActions,
} from '~/components/Apps/listingPublishingActions';
import { showSuccessNotification } from '~/utils/notifications';

/**
 * THE OWNER PUBLISHING LEDGER, now on the authoring page's **Publishing** tab.
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
 *   `renderedActions()` enumerates EVERY interactive control inside the panel's action
 *   container and compares the resulting SET against `OWNER_ACTIONS_BY_STATE` /
 *   `EDITOR_ACTIONS`. It fails when the set SHRINKS (a control was dropped — the #4154 shape)
 *   and when it GROWS (a control was added without being declared). It additionally REFUSES a
 *   control that carries no `data-author-action`, so "grew" cannot be evaded by omitting the
 *   attribute.
 *
 * 🔴 THE LEDGER FOLLOWED THE CONTROLS RATHER THAN BEING DELETED WITH THEM. This PR moves the
 * pair OFF the `/apps/mine` row and onto this tab — structurally the same move that dropped
 * them the first time — so the ledger went red on that move and was RE-POINTED at the panel's
 * container. Deleting it instead would have retired the one instrument aimed at this exact
 * class, in the middle of performing the class.
 *
 * 🔴 THE LEDGER ALONE IS NOT ENOUGH, and the second half is deliberate. A structural set
 * comparison type-checks straight past a button wired to the wrong procedure, or to none —
 * both of which render an identical DOM. `describe('the wiring')` therefore drives each
 * control for real and asserts the exact procedure and the exact input.
 *
 * 🔴 RED-AT-BASE, STATED PRECISELY. `ListingPublishingPanel` does not exist on `origin/main`,
 * so a literal checkout fails on a missing module — a weak claim. The BEHAVIOURAL red is the
 * one that matters and it is stated per test in the PR body's matrix: against `origin/main`
 * the authoring page has no Publishing tab at all and `getAppListingAuthoringContext` refuses
 * a `removed` listing outright, so every case below describes a surface that cannot be
 * reached there.
 *
 * 🔴 WHAT IS MOCK-SHADOWED. The data layer entirely. The `component` project loads no CSS, so
 * nothing here is a claim about layout — only about which controls exist and what they call.
 */

const mocks = vi.hoisted(() => ({
  /** `[procedureName, input]` for every mutation fired, in order. */
  calls: [] as Array<[string, unknown]>,
  republishPending: false,
  /**
   * What `republishOwnListing` resolves to. `'pending'` is a REAL success outcome (the
   * asset-change review route), not an error, and the panel must say so — see
   * `republishSuccessMessage`.
   */
  republishResult: { appListingId: 'apl_1', status: 'approved' } as {
    appListingId: string;
    status: 'approved' | 'pending';
  },
  /** Every `utils.appListings.<proc>.invalidate()` the panel issues, by procedure name. */
  invalidated: [] as string[],
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appBlocksAuthor: true }),
}));

/**
 * One mutation stub that RECORDS which procedure it belongs to — see `the wiring` below.
 *
 * 🔴 IT INVOKES THE CALLER'S `onSuccess`, and that is load-bearing rather than realism for its
 * own sake. `OwnerUnpublishModal` closes itself and calls `onDone` from inside `onSuccess`, so
 * a stub that only recorded the call would leave every post-success behaviour (the surrounding
 * reads invalidating, the modal closing) permanently unexercised — and a test asserting them
 * would pass or fail on nothing at all.
 */
type MutationOpts = { onSuccess?: (data: unknown) => unknown; onError?: (e: unknown) => unknown };
function mutationStub(name: string, isPending = false) {
  return {
    useMutation: (opts?: MutationOpts) => ({
      mutate: (input: unknown) => {
        mocks.calls.push([name, input]);
        // 🔴 A REALISTIC payload, not `undefined`: `republishOwnListing` resolves to
        // `{ appListingId, status }` and the panel DERIVES its success message from that
        // status (a republish whose assets changed lands in `pending`, not live). A stub
        // that hands the handler `undefined` is an unfaithful fake — it cannot see the
        // wrong message and it crashes the handler that reads the field.
        void opts?.onSuccess?.(mocks.republishResult);
      },
      isPending,
    }),
  };
}

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({
      appListings: {
        // 🔴 RECORDED BY NAME, not `vi.fn()` each. Asserting that `refresh()` ran proves
        // nothing about WHICH read it refreshed, and the one that matters is the read this
        // panel's own props come from — see the invalidation test below.
        getAuthoringContext: { invalidate: () => mocks.invalidated.push('getAuthoringContext') },
        listingHistory: { invalidate: () => mocks.invalidated.push('listingHistory') },
        listMine: { invalidate: () => mocks.invalidated.push('listMine') },
      },
    }),
    appListings: {
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
  },
}));

vi.mock('~/utils/notifications', () => ({
  showErrorNotification: vi.fn(),
  showSuccessNotification: vi.fn(),
}));

const { ListingPublishingPanel, PUBLISHING_ACTIONS_TESTID } = await import(
  './ListingPublishingPanel'
);

/**
 * Fixtures are pairwise distinct on every dimension an assertion names — id, slug, status,
 * kind and last moderation action — and none of them can produce an expected value by
 * coincidence. In particular no two fixtures share a `lastModerationAction`. The mod-removed
 * fixture uses `'other'` because that is what the SERVER sends — the projection normalises
 * every non-owner verb to one value so a seated editor never receives the moderator's actual
 * action. That a RAW verb (`delist`/`purge`/`claim`/…) still routes to the same state is
 * pinned in the blocking `unit` tier, not here.
 */
type PanelProps = Parameters<typeof ListingPublishingPanel>[0];
function props(over: Partial<PanelProps> & { appListingId: string }): PanelProps {
  return {
    slug: `slug-${over.appListingId}`,
    kind: 'onsite',
    role: 'owner',
    status: 'approved',
    lastModerationAction: null,
    ...over,
  };
}

const LIVE_ONSITE = props({ appListingId: 'apl_live_on', kind: 'onsite', status: 'approved' });
const LIVE_OFFSITE = props({ appListingId: 'apl_live_off', kind: 'offsite', status: 'approved' });
const OWNER_HIDDEN = props({
  appListingId: 'apl_hidden_q2',
  status: 'removed',
  lastModerationAction: 'owner-unpublish',
});
const MOD_REMOVED = props({
  appListingId: 'apl_modgone_r3',
  status: 'removed',
  lastModerationAction: 'other',
});
const INACTIVE_DRAFT = props({ appListingId: 'apl_draft_k4', status: 'draft' });
const SEAT_LIVE = props({ appListingId: 'apl_seat_m5', status: 'approved', role: 'editor' });

/**
 * Every interactive control in the panel's action container, as declared action ids.
 *
 * 🔴 IT ENUMERATES `button`/`a[href]` AND *THEN* READS THE ATTRIBUTE, in that order. Selecting
 * on `[data-author-action]` directly would make the growth arm inert: a control added without
 * the attribute would simply not be selected, the sets would still match, and the ledger would
 * report clean over a panel that had grown a new affordance nobody registered. Throwing on an
 * undeclared control is what closes that.
 */
function renderedActions(): string[] {
  const container = page.getByTestId(PUBLISHING_ACTIONS_TESTID).element();
  const controls = [...container.querySelectorAll('button, a[href]')];
  const undeclared = controls.filter((c) => !c.getAttribute('data-author-action'));
  if (undeclared.length > 0) {
    throw new Error(
      `${undeclared.length} control(s) in ${PUBLISHING_ACTIONS_TESTID} carry no ` +
        `data-author-action and are therefore invisible to the ledger: ` +
        undeclared.map((c) => `<${c.tagName.toLowerCase()}>${c.textContent ?? ''}`).join(', ')
    );
  }
  return sortPublishingActions(controls.map((c) => c.getAttribute('data-author-action') as string));
}

beforeEach(() => {
  mocks.calls = [];
  mocks.republishPending = false;
  mocks.republishResult = { appListingId: 'apl_1', status: 'approved' };
  mocks.invalidated = [];
});

describe('the ledger — the SET of publishing controls the panel offers, per state', () => {
  test('a LIVE (approved) listing offers exactly Unpublish', async () => {
    renderWithProviders(<ListingPublishingPanel {...LIVE_ONSITE} />);
    await expect.element(page.getByTestId('apps-publishing-panel')).toBeInTheDocument();

    // 🔴 SET EQUALITY, not `toContain`. `toContain('unpublish')` would pass with Republish
    // wrongly rendered beside it, and would pass with three more controls added silently.
    expect(renderedActions()).toEqual(sortPublishingActions(OWNER_ACTIONS_BY_STATE.live));
    // The literal, restated independently of the table — a mutant that empties
    // `OWNER_ACTIONS_BY_STATE.live` would otherwise make the assertion above trivially true.
    expect(renderedActions()).toEqual(['unpublish']);
  });

  test('an OWNER-UNPUBLISHED listing offers exactly Republish, and says "unpublished"', async () => {
    renderWithProviders(<ListingPublishingPanel {...OWNER_HIDDEN} />);
    await expect.element(page.getByTestId('apps-publishing-panel')).toBeInTheDocument();

    expect(renderedActions()).toEqual(
      sortPublishingActions(OWNER_ACTIONS_BY_STATE['owner-hidden'])
    );
    expect(renderedActions()).toEqual(['republish']);

    // 🔴 THE BADGE IS PART OF THE AFFORDANCE. `status` reads `removed` for this listing and
    // for a moderator takedown alike; the badge is what tells the author which one happened,
    // and therefore why one of them has a button and the other does not.
    await expect
      .element(page.getByTestId('apps-publishing-status'))
      .toHaveTextContent('unpublished');

    // 🔴 `.query()` — NOT `expect.element(...).not.toBeInTheDocument()`, which is INERT in
    // this repo (issue #4197: it never fails, for any string). Placed AFTER the awaits above
    // so the render has settled; `.query()` is a point-in-time read.
    expect(page.getByTestId('apps-publishing-unpublish').query()).toBeNull();
    expect(page.getByTestId('apps-publishing-mod-removed').query()).toBeNull();
  });

  test('a MODERATOR-REMOVED listing offers NEITHER control, and says why', async () => {
    renderWithProviders(<ListingPublishingPanel {...MOD_REMOVED} />);
    await expect.element(page.getByTestId('apps-publishing-panel')).toBeInTheDocument();

    expect(renderedActions()).toEqual(sortPublishingActions(OWNER_ACTIONS_BY_STATE['mod-removed']));
    expect(renderedActions()).toEqual([]);

    // 🔴 THE LOAD-BEARING ABSENCE. `republishOwnListing` refuses a listing whose last event is
    // a moderator action — "This listing was removed by a moderator and cannot be restored by
    // its owner." A Republish button here could only ever fail.
    expect(page.getByTestId('apps-publishing-republish').query()).toBeNull();
    expect(page.getByTestId('apps-publishing-unpublish').query()).toBeNull();

    // 🔴 THE POSITIVE CONTROL FOR AN EMPTY LEDGER ENTRY, and it matters more here than it used
    // to. `history` used to be the constant member of every row's action set, so "the set is
    // smaller than expected" was always legible against it. This state now declares the EMPTY
    // set — indistinguishable, structurally, from a panel that rendered nothing at all — so
    // something has to be found on screen by the same mechanism the two nulls are asserted by.
    expect(page.getByTestId('apps-publishing-mod-removed').query()).not.toBeNull();
    await expect
      .element(page.getByTestId('apps-publishing-status'))
      .toHaveTextContent('removed by a moderator');
  });

  test('a never-approved (draft) listing offers nothing, and says there is nothing to take down', async () => {
    renderWithProviders(<ListingPublishingPanel {...INACTIVE_DRAFT} />);
    await expect.element(page.getByTestId('apps-publishing-panel')).toBeInTheDocument();

    expect(renderedActions()).toEqual(sortPublishingActions(OWNER_ACTIONS_BY_STATE.inactive));
    expect(renderedActions()).toEqual([]);
    expect(page.getByTestId('apps-publishing-unpublish').query()).toBeNull();
    // The positive control for THIS empty entry — and a DIFFERENT element from the
    // mod-removed one, so neither case can pass on the other's explanation.
    expect(page.getByTestId('apps-publishing-not-live').query()).not.toBeNull();
    expect(page.getByTestId('apps-publishing-mod-removed').query()).toBeNull();
  });

  test('🔴 a seated COLLABORATOR gets NO control on a LIVE app — a seat is not ownership', async () => {
    renderWithProviders(<ListingPublishingPanel {...SEAT_LIVE} />);
    await expect.element(page.getByTestId('apps-publishing-panel')).toBeInTheDocument();

    // Same status as LIVE_ONSITE, different role — so this case isolates the ROLE branch, the
    // one `editorTabsFor` newly depends on. `editorTabsFor` does not offer an editor this tab
    // at all; this is the panel-level half of the same refusal, for a panel mounted directly.
    expect(renderedActions()).toEqual(sortPublishingActions(EDITOR_ACTIONS));
    expect(renderedActions()).toEqual([]);
    expect(page.getByTestId('apps-publishing-unpublish').query()).toBeNull();
    await expect
      .element(page.getByTestId('apps-publishing-not-live'))
      .toHaveTextContent(/only the app owner/i);
  });
});

describe('🔴 what the ledger can and cannot see — measured, not assumed', () => {
  test('the ledger does not see the confirmation modal’s own buttons', async () => {
    // 🔴 THE SCOPE CLAIM IN `listingPublishingActions.ts`, TURNED INTO A CHECK. That
    // docblock says the ledger sees the action container and nothing else, and names the
    // modal's Cancel/Unpublish pair as outside it. That is a claim about where Mantine puts
    // a `<Modal>` — not something to assert from memory in a comment whose entire subject is
    // the danger of overclaiming coverage.
    renderWithProviders(<ListingPublishingPanel {...LIVE_ONSITE} />);
    // 🔴 AWAIT THE MOUNT BEFORE READING THE DOM. `renderWithProviders` commits
    // asynchronously in browser mode, so a synchronous `renderedActions()` here races it and
    // fails with "Cannot find element" against an empty <body> — which reads as the scope
    // claim being false when it is only the harness being read too early. (It did, on the
    // first run of this case.)
    await expect.element(page.getByTestId('apps-publishing-panel')).toBeInTheDocument();
    const before = renderedActions();
    expect(before).toEqual(['unpublish']);

    await userEvent.click(page.getByTestId('apps-publishing-unpublish'));
    // Positive control: the modal really is open, so an unchanged set below is a fact about
    // the container's contents rather than about a modal that never mounted.
    await expect.element(page.getByTestId('apps-publishing-unpublish-confirm')).toBeInTheDocument();

    // 🔴 UNCHANGED — and `renderedActions()` throws on any control lacking
    // `data-author-action`, so if the modal's buttons HAD landed inside the container this
    // would fail loudly rather than silently growing the set.
    expect(renderedActions()).toEqual(before);
  });
});

describe('the wiring — each control fires the right procedure with the right input', () => {
  test('Unpublish is CONFIRM-GATED, then calls unpublishOwnListing with the listing id', async () => {
    renderWithProviders(<ListingPublishingPanel {...LIVE_ONSITE} />);
    const button = page.getByTestId('apps-publishing-unpublish');
    await expect.element(button).toBeInTheDocument();

    // 🔴 NOTHING FIRES ON THE FIRST CLICK. An unpublish takes a live app off the store (and,
    // on-site, offline); a control that did it on one click would be a different defect from
    // the one being fixed, not a smaller one.
    await userEvent.click(button);
    expect(mocks.calls).toEqual([]);

    const confirm = page.getByTestId('apps-publishing-unpublish-confirm');
    await expect.element(confirm).toBeInTheDocument();
    await userEvent.click(confirm);

    // The WHOLE call list, so a stray call to any other procedure fails here.
    expect(mocks.calls).toEqual([
      ['unpublishOwnListing', { appListingId: 'apl_live_on', reason: undefined }],
    ]);
  });

  test('Republish calls republishOwnListing with the listing id, and needs no confirmation', async () => {
    renderWithProviders(<ListingPublishingPanel {...OWNER_HIDDEN} />);
    const button = page.getByTestId('apps-publishing-republish');
    await expect.element(button).toBeInTheDocument();
    await userEvent.click(button);

    // 🔴 A DIFFERENT ID FROM THE UNPUBLISH CASE, so a mutant that hardcodes either literal
    // fails in one of the two tests. Republish is not confirm-gated on purpose: it restores
    // the previous state, so the recovery from a misclick is the button next to it.
    expect(mocks.calls).toEqual([['republishOwnListing', { appListingId: 'apl_hidden_q2' }]]);
  });

  test('🔴 a republish routed to REVIEW tells the owner so, instead of claiming it is live', async () => {
    /**
     * 🔴 THE MESSAGE IS A CLAIM ABOUT THE SERVER'S ANSWER. `republishOwnListing` routes a
     * republish to `pending` — a re-review — whenever the listing's assets changed since
     * the last approval. The panel used to hardcode "App republished — it is live again",
     * which is FALSE on that arm and survives review precisely because the mutation really
     * did succeed. This drives the real click path and reads the notification the owner
     * would actually see.
     */
    mocks.republishResult = { appListingId: 'apl_hidden_q2', status: 'pending' };
    renderWithProviders(<ListingPublishingPanel {...OWNER_HIDDEN} />);
    const button = page.getByTestId('apps-publishing-republish');
    await expect.element(button).toBeInTheDocument();
    await userEvent.click(button);

    const message = vi.mocked(showSuccessNotification).mock.calls.at(-1)?.[0]?.message as string;
    expect(message).toContain('review');
    // The load-bearing ABSENCE — the old copy must not come back on this arm.
    expect(message).not.toContain('live');
  });

  test('🔴 a republish that DID go live still says so (the other arm of the same branch)', async () => {
    // Positive control on the same assertion: without this, a mutant that always returned
    // the review wording would satisfy the test above.
    mocks.republishResult = { appListingId: 'apl_hidden_q2', status: 'approved' };
    renderWithProviders(<ListingPublishingPanel {...OWNER_HIDDEN} />);
    const button = page.getByTestId('apps-publishing-republish');
    await expect.element(button).toBeInTheDocument();
    await userEvent.click(button);

    const message = vi.mocked(showSuccessNotification).mock.calls.at(-1)?.[0]?.message as string;
    expect(message).toContain('live');
  });

  test('a republish in flight DISABLES the button rather than allowing a second fire', async () => {
    mocks.republishPending = true;
    renderWithProviders(<ListingPublishingPanel {...OWNER_HIDDEN} />);
    const button = page.getByTestId('apps-publishing-republish');
    await expect.element(button).toBeInTheDocument();
    expect(button.element().hasAttribute('disabled')).toBe(true);
  });

  test('🔴 a successful unpublish tells the page to re-read the listing', async () => {
    /**
     * 🔴 THE PANEL IS RENDERED FROM `getAuthoringContext`, WHICH IS THE READ IT JUST
     * INVALIDATED. Without that invalidation the tab keeps rendering `status: 'approved'`
     * after a successful unpublish, so the Unpublish button stays on screen and the author's
     * next click hits a listing that is already removed — the same "the control outlives the
     * state" shape the `/apps/mine` version had to solve by opening the Inactive section.
     *
     * Driven through the real confirm flow rather than by poking a prop, because the whole
     * claim is "on SUCCESS" — `OwnerUnpublishModal` calls `onDone` from its mutation's
     * `onSuccess`, and this test is what pins that wiring rather than the callback in
     * isolation.
     */
    const onChanged = vi.fn();
    renderWithProviders(<ListingPublishingPanel {...LIVE_ONSITE} onChanged={onChanged} />);
    await userEvent.click(page.getByTestId('apps-publishing-unpublish'));
    await userEvent.click(page.getByTestId('apps-publishing-unpublish-confirm'));

    expect(mocks.calls).toEqual([
      ['unpublishOwnListing', { appListingId: 'apl_live_on', reason: undefined }],
    ]);
    expect(onChanged).toHaveBeenCalledTimes(1);

    // 🔴 THE INVALIDATION IS NAMED, not merely counted. `getAuthoringContext` is the read
    // this panel's `status`/`lastModerationAction` props come from AND the read the page's
    // whole tab set is derived from, so it is the one that turns a successful unpublish
    // into a Republish button. A `refresh()` that invalidated only `listMine` would leave
    // the tab rendering `approved` with the Unpublish button still on screen, and the
    // author's next click would hit a listing that is already removed.
    expect(mocks.invalidated).toContain('getAuthoringContext');
  });

  test('🔴 a successful REPUBLISH re-reads the same authoring context', async () => {
    // The mirror of the case above. Both writes change `AppListing.status`, which is the
    // column the tab set and this panel's own state routing read — so a republish that did
    // not invalidate would leave the Republish button on a listing that is live again.
    renderWithProviders(<ListingPublishingPanel {...OWNER_HIDDEN} />);
    const button = page.getByTestId('apps-publishing-republish');
    await expect.element(button).toBeInTheDocument();
    await userEvent.click(button);
    expect(mocks.calls).toEqual([['republishOwnListing', { appListingId: 'apl_hidden_q2' }]]);
    expect(mocks.invalidated).toContain('getAuthoringContext');
  });

  /**
   * 🔴 THE DUAL-KIND TRAP, split into two tests rather than one with an unmount.
   * `/apps/my-submissions` was TWO lists, each passing a FIXED copy variant; this tab serves
   * both kinds. A fixed variant here would tell half of all authors something untrue about
   * what the button is about to do — an on-site unpublish takes the app OFFLINE, an off-site
   * one only delists it from the store. Each test asserts its own wording is present AND that
   * the other kind's wording is not, so neither passes by a variant that renders both strings.
   */
  test('an ON-SITE unpublish warns that the app goes OFFLINE', async () => {
    renderWithProviders(<ListingPublishingPanel {...LIVE_ONSITE} />);
    await userEvent.click(page.getByTestId('apps-publishing-unpublish'));
    await expect.element(page.getByText(/takes your app OFFLINE/i)).toBeInTheDocument();
    expect(page.getByText(/hides your live app from the store/i).query()).toBeNull();
  });

  test('an OFF-SITE unpublish warns only about the STORE listing', async () => {
    renderWithProviders(<ListingPublishingPanel {...LIVE_OFFSITE} />);
    await userEvent.click(page.getByTestId('apps-publishing-unpublish'));
    await expect.element(page.getByText(/hides your live app from the store/i)).toBeInTheDocument();
    expect(page.getByText(/takes your app OFFLINE/i).query()).toBeNull();
  });
});
