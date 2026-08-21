import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import type { IncomingTransferRow } from '~/components/Apps/AppTransferOffersView';
import { CONNECT_CLIENT_TRANSFER_REFUSAL } from '~/shared/constants/app-transfer.constants';
import type * as TrpcModule from '~/utils/trpc';

/**
 * `/apps/invites` — THE RECIPIENT'S OWNERSHIP-OFFER INBOX, DRIVEN FROM THE PAYLOAD.
 *
 * 🔴 THIS SUITE EXISTS BECAUSE THE VIEW WAS VERIFIED IN ISOLATION AND THE DEFECT LIVES IN
 * THE SEAM. `AppTransferOffersView.browser.test.tsx` renders that component with hand-built
 * props and proves every branch of it; #3935's owner-side equivalent did the same and
 * stayed green for months while the app could never reach the state it asserted, because
 * the refusal was passed IN AS A PROP. So nothing here passes a blocked prop. Every arm
 * varies exactly ONE field on the `listMyPendingTransfers` payload — `acceptBlockedReason`
 * — and the chain from there down is real: the page mounts `AppTransferOffers`, the
 * container forwards the rows uncast, and the View decides what to render.
 *
 * WHAT IT PINS: a connect-linked off-site listing is refused at initiate AND re-asserted
 * IN-TRANSACTION at accept, so a card in this inbox can be live, valid-looking and
 * guaranteed to fail — and the refusal reached the recipient only as a toast, after the
 * click. 🔴 That state is NOT reachable through the product today (a listing is born
 * connect-linked or never becomes one, and `initiateTransfer` refuses to open an offer on
 * one that was born linked) — see the honest reachability note on `acceptBlockedReason` in
 * `app-ownership-transfer.service.ts`. This suite is gap-closure ahead of traffic, and the
 * arms below drive the state from the payload precisely BECAUSE nothing else can.
 *
 * 🔴 WHAT IT DOES **NOT** COVER, stated exactly rather than implied, and MEASURED rather
 * than reasoned. The payload comes from the local `offer()` fixture below, NOT from the
 * server, so the `tRPC proc → payload` hop is OUT of frame at RUNTIME: deleting
 * `connectClientId: true` from `listMyPendingTransfers`'s select leaves every test in this
 * file green. That hop belongs to
 * `src/server/services/blocks/__tests__/app-ownership-transfer.inbox.test.ts`, whose Prisma
 * fake projects through the `select`.
 *
 * The SHAPE of the payload is not out of frame, though — not any more. `TransferRow` is
 * `IncomingTransferRow`, so deleting `acceptBlockedReason` from the service's
 * `IncomingTransferView` now FAILS TO COMPILE IN THIS FILE, under BOTH `tsconfig.json` and
 * `tsconfig.tests.json`. Measured, and the load-bearing part is the transition rather than
 * the size: it was ZERO errors here while the fixture carried its own hand-written type —
 * the anti-pattern this PR removes from the container. (An earlier version of this comment
 * quoted an exact count. It rotted within one commit, which is the argument against putting
 * a number here at all: the invariant is "this file notices", not "this file emits N".)
 * Two instruments, two different hops — a `select` line and a field — and neither sees the
 * other's.
 *
 * 🔴 THE SERVER GATES ARE UNCHANGED AND REMAIN THE ENFORCEMENT. Everything below is an
 * addition in front of them, running on data the client could lie to itself about.
 */

/**
 * 🔴 THE FIXTURE'S SHAPE IS THE PAYLOAD'S SHAPE, not a hand-written lookalike.
 *
 * This started life as its own structural duplicate, which is precisely the hole this PR
 * closes in the container — and it was measurably the same hole: deleting
 * `acceptBlockedReason` from the service produced `tsc` errors in the View, in the View's
 * own suite and in the service, and NOTHING here, in the file whose entire purpose is to
 * prove the seam. A suite that claims to drive the real payload has to be pinned to it, or
 * it is testing a shape nobody ships.
 *
 * Derived from {@link IncomingTransferRow} — the View's row type, itself derived from the
 * service's `IncomingTransferView` — so this fixture sits at the END of the same chain the
 * production code does. A type-only import is erased at build time.
 */
type TransferRow = IncomingTransferRow;

const state = vi.hoisted(() => ({
  /**
   * The `listMyPendingTransfers` payload — THE ONLY THING ANY ARM VARIES.
   *
   * Typed as the real row rather than `unknown[]`: it is what the mocked query hands the
   * container, so this is the assignment `tsc` has to see in order for the fixture to be
   * pinned at all. (Declared inside `vi.hoisted`, whose factory is hoisted above the
   * imports — the TYPE reference is erased, so there is nothing left to hoist.)
   */
  transfers: [] as TransferRow[],
  /** Seat invites. Empty everywhere here; the transfer half is the subject. */
  invites: [] as unknown[],
  /** 🔴 Recorded and asserted EMPTY on every blocked arm. A blocked card must not submit. */
  acceptCalls: [] as unknown[],
  /** Recorded so DECLINE can be pinned as still wired, not merely still enabled. */
  cancelCalls: [] as unknown[],
}));

// The page's `getServerSideProps` calls `createServerSideProps` at module top — stub it so
// importing the page in a browser test doesn't pull the server graph (and `sharp`).
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));

// `Meta` reads the app-wide BrowserRouter context, which `renderWithProviders` deliberately
// does not mount. It contributes nothing to this suite's subject.
vi.mock('~/components/Meta/Meta', () => ({
  Meta: () => null,
}));

// Page chrome. `AppsSubNav` runs its own `blocks.getNavSummary` query, a session read and
// the IsClient provider — none of which this suite is about.
vi.mock('~/components/Apps/AppsSubNav', () => ({
  AppsSubNav: () => <div data-testid="stub-subnav" />,
}));

// `UserAvatar` self-fetches over tRPC. Stubbed to a plain span so the offerer slot renders
// without a data layer, exactly as the sibling suites do.
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ userId }: { userId: number }) => <span>user:{userId}</span>,
}));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

// Spread the REAL module and override only `trpc` (per `local-rules/no-wholesale-module-mock`):
// a hand-written replacement silently drops any export a transitive importer needs, and the
// whole file then fails to load as "0 tests collected" — green for the worst possible reason.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  const mutation = (record?: (args: unknown) => void) => ({
    useMutation: () => ({
      mutate: (args: unknown) => record?.(args),
      isPending: false,
      variables: undefined,
    }),
  });
  return {
    ...actual,
    trpc: {
      useUtils: () => ({
        appCollaborators: {
          listMyPendingTransfers: { invalidate: vi.fn().mockResolvedValue(undefined) },
          listMyPendingInvites: { invalidate: vi.fn().mockResolvedValue(undefined) },
        },
        appListings: { listMine: { invalidate: vi.fn().mockResolvedValue(undefined) } },
        blocks: { getNavSummary: { invalidate: vi.fn().mockResolvedValue(undefined) } },
      }),
      appCollaborators: {
        listMyPendingTransfers: {
          useQuery: () => ({ data: state.transfers, isLoading: false, error: null }),
        },
        listMyPendingInvites: {
          useQuery: () => ({ data: state.invites, isLoading: false, error: null }),
        },
        // 🔴 Recorded, and asserted EMPTY on every blocked arm.
        acceptTransfer: mutation((args) => state.acceptCalls.push(args)),
        // DECLINE is `cancelTransfer` — either party may withdraw a pending offer.
        cancelTransfer: mutation((args) => state.cancelCalls.push(args)),
        respondToInvite: mutation(),
      },
    },
  };
});

const AppInvitesPage = (await import('~/pages/apps/invites')).default;

function offer(over: Partial<TransferRow> & { transferId: string }): TransferRow {
  return {
    appListingId: `apl-${over.transferId}`,
    slug: `slug-${over.transferId}`,
    name: `Name ${over.transferId}`,
    kind: 'offsite',
    appBlockId: null,
    iconUrl: null,
    fromUserId: 10,
    expiresAt: new Date('2026-08-17T12:00:00Z'),
    createdAt: new Date('2026-08-10T12:00:00Z'),
    acceptBlockedReason: null,
    ...over,
  };
}

beforeEach(() => {
  state.transfers = [];
  state.invites = [];
  state.acceptCalls = [];
  state.cancelCalls = [];
});

describe('the payload fake honours its input (positive control)', () => {
  /**
   * 🔴 THE FAKE'S OWN CONTROL, deliberately NOT read through the feature under test. Every
   * arm below distinguishes itself by ONE field on the payload this mock returns; if the
   * mock served a frozen list regardless, the positive arm and the control arm would be
   * reading the same rows and both could pass for reasons unrelated to the code.
   *
   * So: prove the payload REACHES the page and VARIES, using a rendered fact this change
   * does not touch — the card is named after the listing, and the `kind` badge differs
   * between an on-site and an off-site offer. Two payloads in, two different renders out.
   */
  test('the payload reaches the page and names the listing it carries', async () => {
    state.transfers = [offer({ transferId: 'aot_1', name: 'Shiny Thing', kind: 'onsite' })];
    renderWithProviders(<AppInvitesPage />);
    const card = page.getByTestId('apps-transfer-aot_1');
    await expect.element(card).toBeInTheDocument();
    await expect.element(card).toHaveTextContent('Shiny Thing');
    await expect.element(card).toHaveTextContent(/On-site app/i);
  });

  test('…and a different payload renders differently (same assertion, other shape)', async () => {
    state.transfers = [offer({ transferId: 'aot_2', name: 'Other Thing', kind: 'offsite' })];
    renderWithProviders(<AppInvitesPage />);
    const card = page.getByTestId('apps-transfer-aot_2');
    await expect.element(card).toBeInTheDocument();
    await expect.element(card).toHaveTextContent('Other Thing');
    // The kind badge, realigned on the store's own word (see listingKindLabels).
    await expect.element(card).toHaveTextContent('Standalone app');
    // The card the OTHER arm rendered is not in this tree, so the two are genuinely
    // distinct renders rather than one cached DOM read twice.
    expect(page.getByTestId('apps-transfer-aot_1').elements()).toHaveLength(0);
  });
});

describe('🔴 AN OFFER THE SERVER WILL REFUSE — said so before the click', () => {
  /**
   * The regression test. NO blocked prop is passed anywhere: the only input is
   * `acceptBlockedReason` on the payload the page fetches.
   */
  test('the refusal is on screen, with the server’s reason intact', async () => {
    state.transfers = [
      offer({ transferId: 'aot_blocked', acceptBlockedReason: CONNECT_CLIENT_TRANSFER_REFUSAL }),
    ];
    renderWithProviders(<AppInvitesPage />);

    const blocked = page.getByTestId('apps-transfer-blocked-aot_blocked');
    await expect.element(blocked).toBeInTheDocument();
    // VERBATIM against the SERVER's own constant — a paraphrase here would let the two
    // sides drift, which is the whole reason the string lives in `shared/`.
    await expect.element(blocked).toHaveTextContent(CONNECT_CLIENT_TRANSFER_REFUSAL);
    // 🔴 `/split ownership/i`, and NOT `/cannot be transferred/i`. #3935 caught that
    // tautology TWICE: the Alert chrome spells the "cannot be transferred" phrasing, so
    // such a regex matches whatever the message body says. Assert on the BODY, which the
    // title cannot supply.
    await expect.element(blocked).toHaveTextContent(/split ownership/i);
    // 🔴 AND IT INSTRUCTS NOTHING. Note the reason is NOT "no unlink path exists" — one
    // does (deleting the OAuth client cascades `SetNull`); that premise is refuted, and
    // since #4126 the constant itself records the refutation alongside the merits-based
    // decision. The reason that matters HERE is that the RECIPIENT cannot take the route:
    // they own neither the listing nor the client, so a remedy addressed to them is a dead
    // end whatever the owner can do. Pinned on the RENDERED text, not just on the constant.
    await expect.element(blocked).not.toHaveTextContent(/unlink/i);
  });

  /**
   * 🔴 STATE, NOT SPELLING. A text match would be satisfied by any copy that happens to
   * mention a refusal; this asserts the actual `disabled` attribute on the actual button.
   */
  test('Accept is DISABLED and Decline is NOT — the way out must stay open', async () => {
    state.transfers = [
      offer({ transferId: 'aot_blocked', acceptBlockedReason: CONNECT_CLIENT_TRANSFER_REFUSAL }),
    ];
    renderWithProviders(<AppInvitesPage />);

    await expect.element(page.getByTestId('apps-transfer-accept-aot_blocked')).toBeDisabled();
    // `cancelTransfer` carries no connect-client gate and admits either party, so
    // withdrawing a dead offer is exactly the action that should still work. Disabling both
    // would strand the recipient with a card they can neither accept nor clear.
    await expect.element(page.getByTestId('apps-transfer-decline-aot_blocked')).toBeEnabled();
  });

  /**
   * …and Decline is WIRED, not merely enabled. An enabled button that calls nothing looks
   * identical in the DOM, so the mutation call is pinned by id.
   */
  test('clicking Decline calls cancelTransfer with THIS offer’s id, and never accepts', async () => {
    state.transfers = [
      offer({ transferId: 'aot_blocked', acceptBlockedReason: CONNECT_CLIENT_TRANSFER_REFUSAL }),
    ];
    renderWithProviders(<AppInvitesPage />);

    const decline = page.getByTestId('apps-transfer-decline-aot_blocked');
    await expect.element(decline).toBeInTheDocument();
    await userEvent.click(decline.element());

    expect(state.cancelCalls).toEqual([{ transferId: 'aot_blocked' }]);
    expect(state.acceptCalls).toEqual([]);
  });

  /**
   * 🔴 THE DISCLOSURE PANEL IS RETAINED ON A BLOCKED CARD — an operator decision, and a
   * deliberate divergence from #3935, which suppressed the owner-side equivalent.
   *
   * Two reasons. It is a load-bearing IDENTITY marker: the pair test in
   * `src/components/Apps/AppTransferOffersView.browser.test.tsx` names this panel as one of
   * three things stopping an irreversible ownership transfer from reading like a reversible
   * seat invite, and dropping it on some cards makes that property conditional on data.
   * And unlike the owner's suppressed copy — which described MECHANICS of a transfer that
   * can never start — this describes what the offer WAS FOR, which is precisely what the
   * recipient still needs in order to decide to decline it.
   *
   * INVARIANT GUARD, labelled: this passes on `origin/main` too, because main renders the
   * panel on every card. It is here to pin the KEEP decision against a future "tidy up the
   * blocked card", not as regression coverage for the shipped defect — the three tests
   * above are that.
   */
  test('the "what accepting does" disclosure is STILL SHOWN on a blocked card', async () => {
    state.transfers = [
      offer({
        transferId: 'aot_blocked',
        kind: 'onsite',
        appBlockId: 'ab_1',
        acceptBlockedReason: CONNECT_CLIENT_TRANSFER_REFUSAL,
      }),
    ];
    renderWithProviders(<AppInvitesPage />);

    const warning = page.getByTestId('apps-transfer-warning-aot_blocked');
    await expect.element(warning).toBeInTheDocument();
    await expect.element(warning).toHaveTextContent(/current owner loses ownership/i);
    await expect.element(warning).toHaveTextContent(/become the owner/i);
    // The badge and section that complete the same identity trio are still there too.
    await expect
      .element(page.getByTestId('apps-transfer-badge-aot_blocked'))
      .toHaveTextContent(/Ownership transfer/i);
    await expect
      .element(page.getByTestId('apps-transfers-section'))
      .toHaveTextContent(/Ownership transfers/i);
  });

  /**
   * 🔴 THE CARD IS BLOCKED, NOT HIDDEN. Suppressing the row was considered and rejected:
   * `initiateTransfer` fires a notification pointing at `/apps/invites`, so hiding it makes
   * that notification land on a page rendering nothing, removes the recipient's only
   * action, and leaves the owner's own tab (which still shows the offer) disagreeing with
   * this one about whether an offer exists.
   */
  /**
   * 🔴 ONE PREDICATE, PINNED BEHAVIOURALLY — the two branches must agree on EVERY value of
   * the field, not just on the two the service can send today.
   *
   * They used to disagree: the banner tested `blockedReason ? …` and the button tested
   * `blockedReason != null`. Both agree on the constant and on `null`, and they diverge on
   * `''` — Accept disabled with NO explanation rendered, a card the recipient can neither
   * accept nor understand. Unreachable while there is exactly one reason, and reachable the
   * moment someone adds a second without knowing the branches differ.
   *
   * So the empty string is the discriminating input, and it is fed on the PAYLOAD like
   * every other arm. The assertion is that the two branches move TOGETHER: the banner
   * element is present (its `title` still explains the card even with an empty body) AND
   * Accept is disabled. A comment could not have held this; this arm goes red the moment
   * the predicates are re-split.
   */
  test('🔴 an EMPTY reason still renders the banner AND disables Accept — one predicate', async () => {
    state.transfers = [offer({ transferId: 'aot_empty', acceptBlockedReason: '' })];
    renderWithProviders(<AppInvitesPage />);

    await expect.element(page.getByTestId('apps-transfer-blocked-aot_empty')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-transfer-accept-aot_empty')).toBeDisabled();
    // …and Decline stays the way out, exactly as on a normally-blocked card.
    await expect.element(page.getByTestId('apps-transfer-decline-aot_empty')).toBeEnabled();
  });

  /**
   * 🔴 A MISSING FIELD MUST FAIL **OPEN** — the deploy-skew arm, and the one case the type
   * system cannot describe, which is exactly why it needs a test.
   *
   * The bundle and the tRPC API are served by pools that roll INDEPENDENTLY, so every
   * deploy passes through a window where this component runs against an API that predates
   * `acceptBlockedReason`. The field then arrives ABSENT, not `null`. Under a strict
   * `!== null` the card scores as BLOCKED: every pending offer refused, with an empty
   * explanation, for offers that are perfectly fine — and since the banner is otherwise
   * unreachable, that mid-roll false refusal would be the only time a real user ever saw
   * it. Under `!= null` the card is ordinary and the server stays the enforcement, which
   * is the direction that cannot invent a refusal.
   *
   * 🔴 THE CAST IS THE POINT, not a shortcut. `TransferRow` correctly forbids a missing
   * field, so the only way to express "what an older server actually sends" is to step
   * outside the type — a payload the CURRENT contract cannot produce and a PREVIOUS one
   * did. Deleting the cast would delete the scenario.
   *
   * 🔴 CONTROL / INVARIANT GUARD, LABELLED — this PASSES at `origin/main`, and measured so
   * rather than assumed (5 failed / 8 passed at base; this arm is one of the 8). It passes
   * there for a trivial reason: base has no banner and no disable at all, so an absent
   * field is acceptable by construction. It is therefore NOT regression coverage for the
   * shipped defect — the arms above are. Its job is to hold the fail-OPEN direction against
   * a future tightening, and mutant (q) (`!= null` → `!== null`) is what earns it: (q) dies
   * here and NOWHERE else in the suite.
   */
  test('🔴 an ABSENT reason (old API, new bundle) leaves the offer ACCEPTABLE — fail open', async () => {
    const legacyRow = offer({ transferId: 'aot_legacy' }) as Partial<TransferRow>;
    delete legacyRow.acceptBlockedReason;
    expect('acceptBlockedReason' in legacyRow).toBe(false);
    state.transfers = [legacyRow as TransferRow];
    renderWithProviders(<AppInvitesPage />);

    // Positive control FIRST: the card rendered at all, so the absences below are real
    // absences and not an un-awaited render (`elements()` is synchronous).
    const accept = page.getByTestId('apps-transfer-accept-aot_legacy');
    await expect.element(accept).toBeInTheDocument();
    await expect.element(accept).toBeEnabled();
    expect(page.getByTestId('apps-transfer-blocked-aot_legacy').elements()).toHaveLength(0);

    // …and it genuinely submits, so "enabled" is not a button that quietly does nothing.
    await userEvent.click(accept.element());
    expect(state.acceptCalls).toEqual([{ transferId: 'aot_legacy' }]);
  });

  test('the offer still renders as an offer — name, deadline and all', async () => {
    state.transfers = [
      offer({
        transferId: 'aot_blocked',
        name: 'Connected Thing',
        acceptBlockedReason: CONNECT_CLIENT_TRANSFER_REFUSAL,
      }),
    ];
    renderWithProviders(<AppInvitesPage />);

    const card = page.getByTestId('apps-transfer-aot_blocked');
    await expect.element(card).toBeInTheDocument();
    await expect.element(card).toHaveTextContent('Connected Thing');
    await expect
      .element(page.getByTestId('apps-transfer-expiry-aot_blocked'))
      .toHaveTextContent('Aug 17, 2026');
    await expect.element(page.getByTestId('apps-transfer-offerer-aot_blocked')).toBeInTheDocument();
  });

  /*
   * 🔴 THERE IS DELIBERATELY NO LEAK TEST HERE, and its absence is a correction rather
   * than a gap. An earlier revision asserted `'connectClientId' in row` against this
   * file's OWN `offer()` factory — no render, no production code — so it could not fail
   * for any change under `src/`. A test that cannot go red is worse than no test, because
   * it reads as coverage. The real guard is in
   * `src/server/services/blocks/__tests__/app-ownership-transfer.inbox.test.ts`, which
   * asserts the property on what the SERVICE actually returns, with the fixture's column
   * present as its positive control. The shape claim this file can honestly make is now
   * made by `tsc` instead: `TransferRow` IS `IncomingTransferRow`, so a `connectClientId`
   * appearing on the payload would have to appear in the service's own type first.
   */
});

describe('🔴 THE CONTROL ARM — an offer with no reason is untouched', () => {
  /**
   * 🔴 AS IMPORTANT AS THE POSITIVE ARM. Without it, "disable every Accept" and "render the
   * banner always" trivially satisfy everything above and ship an inbox where no offer can
   * ever be accepted.
   *
   * PASSES ON `origin/main` TOO, and that is what a control arm is FOR rather than a
   * weakness in it — main also rendered an enabled Accept here. Its job is to go red the
   * moment the fix over-reaches, which the mutation battery confirms it does.
   */
  test('Accept is ENABLED, and no refusal banner is rendered', async () => {
    state.transfers = [offer({ transferId: 'aot_ok', acceptBlockedReason: null })];
    renderWithProviders(<AppInvitesPage />);

    const accept = page.getByTestId('apps-transfer-accept-aot_ok');
    await expect.element(accept).toBeInTheDocument();
    await expect.element(accept).toBeEnabled();
    // Absence, with the awaited present element above as its positive control —
    // `locator.elements()` is SYNCHRONOUS, so an emptiness asserted straight after render
    // passes whatever the component does.
    expect(page.getByTestId('apps-transfer-blocked-aot_ok').elements()).toHaveLength(0);
  });

  /** …and Accept is WIRED, so "enabled" is not a button that quietly does nothing. */
  test('clicking Accept calls acceptTransfer with THIS offer’s id', async () => {
    state.transfers = [offer({ transferId: 'aot_ok', acceptBlockedReason: null })];
    renderWithProviders(<AppInvitesPage />);

    const accept = page.getByTestId('apps-transfer-accept-aot_ok');
    await expect.element(accept).toBeInTheDocument();
    await userEvent.click(accept.element());

    expect(state.acceptCalls).toEqual([{ transferId: 'aot_ok' }]);
  });
});

describe('🔴 A MIXED INBOX — the arm that kills "disable every Accept"', () => {
  /**
   * 🔴 THE DECISIVE ARM. Every other test here renders ONE card, and a fix that blocked the
   * whole section rather than the offending row would satisfy the positive arms and the
   * control arms alike, each in its own render. Only both rows in ONE tree can tell
   * "per-offer" from "per-page".
   *
   * The two rows differ in EXACTLY one field. Same kind, same offerer, same deadline — so
   * nothing else in the payload can explain a difference in what renders.
   */
  test('the blocked offer is refused and the healthy one beside it is not', async () => {
    state.transfers = [
      offer({ transferId: 'aot_blocked', acceptBlockedReason: CONNECT_CLIENT_TRANSFER_REFUSAL }),
      offer({ transferId: 'aot_ok', acceptBlockedReason: null }),
    ];
    renderWithProviders(<AppInvitesPage />);

    // Both cards are in this ONE tree — the combined state, not two isolated renders.
    await expect.element(page.getByTestId('apps-transfer-aot_blocked')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-transfer-aot_ok')).toBeInTheDocument();

    await expect.element(page.getByTestId('apps-transfer-blocked-aot_blocked')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-transfer-accept-aot_blocked')).toBeDisabled();

    await expect.element(page.getByTestId('apps-transfer-accept-aot_ok')).toBeEnabled();
    expect(page.getByTestId('apps-transfer-blocked-aot_ok').elements()).toHaveLength(0);
  });

  /**
   * …and the healthy one is still SUBMITTABLE from that same tree, while the blocked one
   * contributes nothing. `toBeEnabled()` is a DOM state; this is the behaviour.
   */
  test('the healthy offer still submits, and the blocked one never does', async () => {
    state.transfers = [
      offer({ transferId: 'aot_blocked', acceptBlockedReason: CONNECT_CLIENT_TRANSFER_REFUSAL }),
      offer({ transferId: 'aot_ok', acceptBlockedReason: null }),
    ];
    renderWithProviders(<AppInvitesPage />);

    const okAccept = page.getByTestId('apps-transfer-accept-aot_ok');
    await expect.element(okAccept).toBeInTheDocument();
    await userEvent.click(okAccept.element());
    // Clicking the disabled one is a no-op in a real browser; asserting it explicitly is
    // what makes "disabled" mean "cannot submit" rather than "looks greyed out".
    await userEvent.click(page.getByTestId('apps-transfer-accept-aot_blocked').element(), {
      force: true,
    });

    expect(state.acceptCalls).toEqual([{ transferId: 'aot_ok' }]);
  });
});
