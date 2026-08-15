import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { useRouter } from 'next/router';
import { CONNECT_CLIENT_TRANSFER_REFUSAL } from '~/shared/constants/app-transfer.constants';
import { capabilitiesForKind } from '~/shared/constants/app-capabilities.constants';
import { constants } from '~/server/common/constants';
import type * as TrpcModule from '~/utils/trpc';

/**
 * OWNERSHIP TRANSFER, DRIVEN FROM LISTING DATA — the `/apps/listing/<id>/edit`
 * Collaborators tab, end to end from the `getAuthoringContext` payload.
 *
 * 🔴 THIS SUITE EXISTS BECAUSE THE PANEL WAS VERIFIED IN ISOLATION AND THE DEFECT LIVED
 * IN THE SEAM. `AppCollaboratorsPanelView.browser.test.tsx` proves the connect-client
 * refusal RENDERS — by handing `transferErrorMessage={CONNECT_CLIENT_TRANSFER_REFUSAL}`
 * in as a prop. That is a true statement about the View and says nothing whatsoever about
 * whether the app can ever REACH that state, and it could not: `transferErrorMessage` is
 * only ever set from a MUTATION ERROR, so the owner of a connect-linked off-site listing
 * saw an ordinary enabled recipient picker, chose someone, submitted, and learned only
 * then that the server refuses this listing every time. Measured on production: three of
 * the four off-site listings carry a `connect_client_id`, and the transfer section
 * rendered byte-identically on all of them and on a listing with no client at all.
 *
 * 🔴 SO NOTHING HERE PASSES A TRANSFER PROP. Every arm sets ONE thing — the
 * `connectClientId` on the authoring-context payload — and then asserts what the owner
 * sees. The chain from that payload down is real: the page reads it, hands the two listing
 * facts to the container, the container forwards them, and the View asks
 * `refusesTransferForConnectClient`, the SAME predicate the service gates on.
 *
 * 🔴 WHAT THIS SUITE DOES **NOT** COVER, stated exactly, because an earlier version of this
 * comment claimed "break any link of that chain and these tests go red" and that was
 * measurably false. The payload comes from the local `contextFor()` fixture below, NOT from
 * the server — so the `tRPC proc → payload` hop is OUT of frame here, and deleting
 * `connectClientId` from `getAppListingAuthoringContext` leaves this file at 10 passed.
 * That hop is covered by its own suite
 * (`src/server/services/blocks/__tests__/app-access.authoring-context-connect-client.test.ts`,
 * whose Prisma fake projects through the `select`) and, since the page's `AuthoringContext`
 * is now an alias of the service's own return type rather than a hand-written duplicate,
 * by `tsc`. Three instruments, three hops; no one of them sees all of it.
 *
 * 🔴 AND THE CONTROL ARM IS NOT OPTIONAL. "Disable the transfer section" satisfies the
 * positive arm on its own, and would ship a panel where nobody can ever transfer
 * anything. A listing with NO client must still render an ENABLED picker; that arm is
 * how the defect was found in the first place (an off-site listing without a client
 * rendering the same as one with a client is what proved the copy was not client-aware),
 * so it is pinned here with equal weight.
 */

type AuthoringContext = {
  appListingId: string;
  slug: string;
  name: string;
  status: string;
  kind: 'onsite' | 'offsite';
  appBlockId: string | null;
  connectClientId: string | null;
  role: string;
  capabilities: Readonly<Record<string, boolean>>;
};

const state = vi.hoisted(() => ({
  /** The `getAuthoringContext` payload — THE ONLY THING ANY ARM VARIES. */
  context: null as unknown,
  /** Roster rows `appCollaborators.list` returns. Empty everywhere here. */
  rows: [] as unknown[],
  /** A live outgoing offer, or null. Null everywhere here (the picker is the subject). */
  pendingTransfer: null as unknown,
  /** Every `initiateTransfer.mutate` call. MUST stay empty — nothing here submits. */
  initiateCalls: [] as unknown[],
  /**
   * The props the REAL recipient picker was mounted with, or null if it never mounted.
   * `null` is the assertion that matters on a refused listing: the control is not merely
   * greyed out, it is not in the tree, so no path through it can fire the mutation.
   */
  transferPickerProps: null as null | { disabled?: boolean; placeholder?: string },
  flags: { appBlocks: true } as Record<string, boolean>,
}));

// The page's `getServerSideProps` calls createServerSideProps at module top — stub it so
// importing the page in a browser test doesn't pull the server graph (and `sharp`).
vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: () => async () => ({ props: {} }),
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => state.flags,
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 10, username: 'owner' }),
}));

vi.mock('~/components/AppLayout/NotFound', () => ({
  NotFound: () => <div data-testid="not-found">Not found</div>,
}));

// `Meta` reads the app-wide BrowserRouter context, which `renderWithProviders`
// deliberately does not mount. It contributes nothing to this suite's subject.
vi.mock('~/components/Meta/Meta', () => ({
  Meta: () => null,
}));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

/**
 * 🔴 THE RECIPIENT PICKER STUB, AND IT HONOURS ITS INPUT. It renders a REAL `<input>`
 * carrying the `disabled` it was handed, so "the picker is usable" is read off the DOM
 * rather than off a prop we captured — and it records its props, so a test can tell "not
 * mounted" from "mounted and disabled". A stub that ignored `disabled` would make the
 * control arm vacuous.
 *
 * Stubbing it is also what makes importing the page possible at all: the real
 * `QuickSearchDropdown` reaches a Meilisearch client that reads its host URL AT IMPORT
 * TIME and throws.
 */
vi.mock('~/components/Search/QuickSearchDropdown', () => ({
  QuickSearchDropdown: (props: { disabled?: boolean; placeholder?: string }) => {
    // The TRANSFER picker is the one whose placeholder names an owner; the invite picker
    // uses different copy. Only the transfer one is the subject here.
    const isTransfer = (props.placeholder ?? '').includes('should own this app');
    if (isTransfer) state.transferPickerProps = props;
    return (
      <input
        readOnly
        disabled={props.disabled}
        aria-label={props.placeholder}
        placeholder={props.placeholder}
        data-testid={isTransfer ? 'stub-transfer-picker' : 'stub-invite-picker'}
      />
    );
  },
}));

vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ userId }: { userId: number }) => <span>user:{userId}</span>,
}));

// The other tabs' bodies — never rendered here (`?tab=collaborators`), stubbed only to
// keep their module graphs out of the browser build.
vi.mock('~/components/Apps/AppsSubmitEditView', () => ({
  AppsListingDetailsEditor: () => <div data-testid="stub-details" />,
}));
vi.mock('~/components/Apps/ListingMediaEditor', () => ({
  ListingMediaEditor: () => <div data-testid="stub-media" />,
}));
vi.mock('~/components/Apps/ManifestEditForm', () => ({
  ManifestEditForm: () => <div data-testid="stub-manifest" />,
}));
vi.mock('~/components/Apps/AppEarningsPanel', () => ({
  AppEarningsPanel: () => <div data-testid="stub-earnings" />,
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
    }),
  });
  return {
    ...actual,
    trpc: {
      useUtils: () => ({
        appCollaborators: {
          list: { invalidate: vi.fn().mockResolvedValue(undefined) },
          getPendingTransfer: { invalidate: vi.fn().mockResolvedValue(undefined) },
        },
      }),
      appListings: {
        getAuthoringContext: {
          useQuery: () => ({
            data: state.context,
            isLoading: state.context == null,
            error: null,
          }),
        },
      },
      appCollaborators: {
        list: { useQuery: () => ({ data: state.rows, isLoading: false, error: null }) },
        getPendingTransfer: {
          useQuery: () => ({ data: state.pendingTransfer, isLoading: false, error: null }),
        },
        invite: mutation(),
        remove: mutation(),
        setDisplayed: mutation(),
        leave: mutation(),
        // 🔴 Recorded, and asserted EMPTY. A refused listing must not be able to submit.
        initiateTransfer: mutation((args) => state.initiateCalls.push(args)),
        cancelTransfer: mutation(),
      },
    },
  };
});

const AppListingEditPage = (await import('~/pages/apps/listing/[appListingId]/edit')).default;

const LISTING_ID = 'apl_transfer';

function contextFor(over: Partial<AuthoringContext>): AuthoringContext {
  const kind = over.kind ?? 'offsite';
  return {
    appListingId: LISTING_ID,
    slug: 'my-app',
    name: 'My App',
    status: 'approved',
    kind,
    appBlockId: kind === 'onsite' ? 'ab_1' : null,
    connectClientId: null,
    role: 'owner',
    capabilities: capabilitiesForKind(kind),
    ...over,
  };
}

/** Point the mocked router at the Collaborators tab of this listing. */
function openCollaboratorsTab() {
  const router = (useRouter as unknown as () => { query: Record<string, string> })();
  router.query.appListingId = LISTING_ID;
  router.query.tab = 'collaborators';
}

beforeEach(() => {
  state.context = null;
  state.rows = [];
  state.pendingTransfer = null;
  state.initiateCalls = [];
  state.transferPickerProps = null;
  state.flags = { appBlocks: true };
  openCollaboratorsTab();
});

describe('the authoring-context fake honours its input (positive control)', () => {
  /**
   * 🔴 THE FAKE'S OWN CONTROL, and it is deliberately NOT read through the feature under
   * test. Every arm below distinguishes itself by ONE field on the payload this mock
   * returns; if the mock served a frozen listing regardless, the positive arm and the
   * control arm would be reading the same shape and both could pass for reasons unrelated
   * to the code.
   *
   * So: prove the payload REACHES the page and VARIES, using a rendered fact this PR does
   * not touch — the invite disclosure, which promises code/version access on an ON-SITE
   * listing and must not on an OFF-SITE one. Two payloads in, two different renders out.
   */
  test('the payload reaches the page and different payloads render differently', async () => {
    state.context = contextFor({ kind: 'onsite', connectClientId: null });
    renderWithProviders(<AppListingEditPage />);
    await expect
      .element(page.getByTestId('apps-collaborators-invite-disclosure'))
      .toHaveTextContent(/Push code/i);
  });

  test('…and the off-site payload renders the other way (same assertion, other shape)', async () => {
    state.context = contextFor({ kind: 'offsite', connectClientId: null });
    renderWithProviders(<AppListingEditPage />);
    const disclosure = page.getByTestId('apps-collaborators-invite-disclosure');
    await expect.element(disclosure).toBeInTheDocument();
    await expect.element(disclosure).not.toHaveTextContent(/Push code/i);
  });

  /** And the field this PR turns on is genuinely different between the two shapes. */
  test('the two listing shapes differ in connectClientId', () => {
    expect(contextFor({ connectClientId: 'oc_linked' }).connectClientId).toBe('oc_linked');
    expect(contextFor({ connectClientId: null }).connectClientId).toBeNull();
  });
});

describe('🔴 an OFF-SITE listing WITH a connect client — refused UP FRONT', () => {
  /**
   * The regression test. NO transfer prop is passed anywhere; the only input is the
   * listing's own `connectClientId` on the payload the page fetches.
   */
  test('the refusal is on screen before the owner picks anyone, with the server’s reason', async () => {
    state.context = contextFor({ kind: 'offsite', connectClientId: 'oc_linked' });
    renderWithProviders(<AppListingEditPage />);

    const blocked = page.getByTestId('apps-transfer-blocked');
    await expect.element(blocked).toBeInTheDocument();
    // Verbatim against the SERVER's own constant — a paraphrase here would let the two
    // sides drift, which is the whole reason the string lives in `shared/`.
    await expect.element(blocked).toHaveTextContent(CONNECT_CLIENT_TRANSFER_REFUSAL);
    // 🔴 `/split ownership/i` and NOT `/cannot be transferred/i`, which would be a
    // TAUTOLOGY: this Alert's own `title` prop reads "Ownership cannot be transferred for
    // this app", so that regex matches the chrome whatever the message says. Caught by
    // running this file against the previous branch tip, where the assertion passed
    // against the OLD constant. Match on the message BODY, which the title cannot supply.
    await expect.element(blocked).toHaveTextContent(/split ownership/i);
    // 🔴 AND IT INSTRUCTS NOTHING THE OWNER CANNOT DO. This banner is now PERMANENT on a
    // connect-linked listing, so a false remedy would be a permanent false remedy — there
    // is no unlink path in the product (`connectClientId` is required at submit and
    // immutable on edit). Pinned on the RENDERED text, not just the constant, because this
    // surface is what made the difference between "a wrong sentence in an error" and "a
    // wrong sentence on every visit".
    await expect.element(blocked).not.toHaveTextContent(/unlink/i);
  });

  /**
   * 🔴 STATE, NOT SPELLING. A text match on /client/i would be satisfied by any copy that
   * happens to mention a client; this asserts the actual `disabled` attribute on the
   * actual control that stands where the picker would be.
   */
  test('the recipient control is DISABLED, and the real picker is not mounted at all', async () => {
    state.context = contextFor({ kind: 'offsite', connectClientId: 'oc_linked' });
    renderWithProviders(<AppListingEditPage />);

    // Positive control FIRST: the section is present, so the absence below is a real
    // absence and not an un-awaited render. (`elements()` is synchronous.)
    await expect.element(page.getByTestId('apps-transfer-owner-section')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-transfer-picker-disabled')).toBeDisabled();
    expect(page.getByTestId('stub-transfer-picker').elements()).toHaveLength(0);
    expect(state.transferPickerProps).toBeNull();
  });

  /**
   * 🔴 THE SECTION IS DISABLED, NOT HIDDEN — a deliberate product choice. A vanished
   * section leaves the owner wondering why transfer does not exist for their app, which
   * is a different confusion rather than a smaller one. The heading and the disclosure
   * stay, so the reason sits next to the thing it is about.
   *
   * INVARIANT GUARD, labelled: this PASSES on `origin/main` too, because main rendered
   * the section as well (just enabled). It pins the disable-don't-hide decision against a
   * future "simplify" that deletes the section, and is NOT regression coverage for the
   * shipped defect — the three tests above are.
   */
  test('the section itself still renders — the refusal explains a control, not a void', async () => {
    state.context = contextFor({ kind: 'offsite', connectClientId: 'oc_linked' });
    renderWithProviders(<AppListingEditPage />);

    await expect.element(page.getByTestId('apps-transfer-owner-section')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-transfer-owner-disclosure')).toBeInTheDocument();
  });

  /**
   * …but the section does NOT keep reciting the mechanics of a transfer that can never
   * start. "One transfer offer at a time. It expires after N days if it is not accepted"
   * is reassuring, specific and irrelevant here — the combination most easily read as
   * "so a transfer IS possible, I just have to find the button".
   */
  test('the one-offer-at-a-time expiry copy is suppressed', async () => {
    state.context = contextFor({ kind: 'offsite', connectClientId: 'oc_linked' });
    renderWithProviders(<AppListingEditPage />);

    const section = page.getByTestId('apps-transfer-owner-section');
    await expect.element(section).toBeInTheDocument();
    await expect.element(section).not.toHaveTextContent(/One transfer offer at a time/i);
  });

  /**
   * 🔴 THE REFUSAL ARRIVES WITHOUT A MUTATION ERROR — which is the entire fix. The
   * mutation-error panel (`apps-transfer-owner-error`) is the OLD route to this message,
   * and it must still be empty: nothing has been submitted, and nothing can be.
   */
  test('no mutation error panel, and initiateTransfer is never called', async () => {
    state.context = contextFor({ kind: 'offsite', connectClientId: 'oc_linked' });
    renderWithProviders(<AppListingEditPage />);

    await expect.element(page.getByTestId('apps-transfer-blocked')).toBeInTheDocument();
    expect(page.getByTestId('apps-transfer-owner-error').elements()).toHaveLength(0);
    expect(state.initiateCalls).toEqual([]);
  });
});

describe('🔴 a LIVE OFFER on a connect-linked listing — dead on accept, and said so', () => {
  /**
   * 🔴 A REAL CO-EXISTING STATE, NOT A HYPOTHETICAL. `app-ownership-transfer.service`
   * re-asserts the connect-client refusal IN-TRANSACTION at accept precisely because "a
   * revision approve can link a client while the offer sits open" — so a listing can carry
   * a live `pending` offer AND be un-transferable at the same time.
   *
   * Before this arm existed the tab rendered "ownership cannot be transferred" directly
   * above a "Transfer pending → Cancel transfer" card, with nothing saying which one won.
   * The offer is dead on accept, and the recipient will hit the refusal with no warning.
   *
   * 🔴 THIS IS ALSO THE ARM THAT KILLS A MUTANT THAT PREVIOUSLY SURVIVED THE WHOLE SUITE:
   * gating the verdict on `pendingTransfer == null` passed all 40 tests, because every
   * other arm here has no pending offer. A guard nothing exercises in this state is a
   * guard that can be silently removed in this state.
   */
  test('the refusal, a dead-offer notice, and a still-usable Cancel all render together', async () => {
    state.context = contextFor({ kind: 'offsite', connectClientId: 'oc_linked' });
    state.pendingTransfer = { id: 'aot_live', toUserId: 42, expiresAt: new Date() };
    renderWithProviders(<AppListingEditPage />);

    // The verdict still applies while an offer is open…
    await expect.element(page.getByTestId('apps-transfer-blocked')).toBeInTheDocument();
    // …the owner is told the open offer is now dead…
    const dead = page.getByTestId('apps-transfer-pending-dead');
    await expect.element(dead).toBeInTheDocument();
    await expect.element(dead).toHaveTextContent(/can no longer be accepted/i);
    // …and Cancel — the only way out of a stale offer — is present and NOT disabled.
    await expect.element(page.getByTestId('apps-transfer-cancel')).toBeEnabled();
  });

  /**
   * The control for the arm above: with an offer open and NO client, the pending card is
   * ordinary. Without this, "always render the dead-offer notice" would satisfy the test
   * above — the same over-reach the enabled-picker control arm guards against.
   */
  test('CONTROL — an offer on a listing with no client shows no dead-offer notice', async () => {
    state.context = contextFor({ kind: 'offsite', connectClientId: null });
    state.pendingTransfer = { id: 'aot_live', toUserId: 42, expiresAt: new Date() };
    renderWithProviders(<AppListingEditPage />);

    await expect.element(page.getByTestId('apps-transfer-pending')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-transfer-cancel')).toBeEnabled();
    expect(page.getByTestId('apps-transfer-pending-dead').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-transfer-blocked').elements()).toHaveLength(0);
  });
});

describe('🔴 THE CONTROL ARM — an OFF-SITE listing with NO connect client', () => {
  /**
   * 🔴 AS IMPORTANT AS THE POSITIVE ARM. Without it, "disable the section" trivially
   * satisfies everything above and ships a panel nobody can transfer from. This is also
   * the arm that made the live diff meaningful: an off-site listing with no client
   * rendering identically to one with a client is what proved the copy was not
   * client-aware.
   *
   * PASSES ON `origin/main` TOO, and that is what a control arm is FOR rather than a
   * weakness in it — main also rendered an enabled picker here. Its job is to go red the
   * moment the fix over-reaches, which the mutation battery confirms it does.
   */
  test('the transfer picker is ENABLED and no refusal is shown', async () => {
    state.context = contextFor({ kind: 'offsite', connectClientId: null });
    renderWithProviders(<AppListingEditPage />);

    const picker = page.getByTestId('stub-transfer-picker');
    await expect.element(picker).toBeInTheDocument();
    await expect.element(picker).toBeEnabled();
    // Absence, with the awaited present element above as its positive control.
    expect(page.getByTestId('apps-transfer-blocked').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-transfer-picker-disabled').elements()).toHaveLength(0);
  });

  /**
   * 🔴 THE POSITIVE CONTROL FOR THE SUPPRESSION TEST, and its absence was a real hole.
   *
   * The refused arm asserts the expiry copy is NOT rendered. Nothing anywhere asserted it
   * is EVER rendered — so DELETING the block outright left the whole suite green, and the
   * negative assertion could not distinguish "correctly suppressed when refused" from
   * "this helper text no longer exists for anybody".
   *
   * 🔴 THE INVERSION MUTANT DOES NOT COVER THIS. "Stop suppressing" and "delete entirely"
   * fail in OPPOSITE directions: a suite that catches one is structurally blind to the
   * other, which is why the deletion mutant survived a battery that killed the inversion.
   * A negative assertion is only meaningful next to a positive one on the same string.
   */
  test('…and the transfer helper copy DOES render on a listing that can transfer', async () => {
    state.context = contextFor({ kind: 'offsite', connectClientId: null });
    renderWithProviders(<AppListingEditPage />);

    const section = page.getByTestId('apps-transfer-owner-section');
    await expect.element(section).toBeInTheDocument();
    await expect.element(section).toHaveTextContent(/One transfer offer at a time/i);
    // The expiry figure comes from `constants`, so pin that it is interpolated at all
    // rather than left as a literal — the sentence is only useful with a number in it.
    await expect
      .element(section)
      .toHaveTextContent(
        new RegExp(`expires after\\s*${constants.appCollaborators.transferExpiryDays}\\s*days`, 'i')
      );
  });
});

describe('🔴 an ON-SITE listing — transfer stays available', () => {
  /**
   * On-site listings carry no `connectClientId` (their OauthClient is reached through the
   * AppBlock, and THAT one does move with the app), so the refusal must never reach them.
   */
  test('the transfer picker is ENABLED and no refusal is shown', async () => {
    state.context = contextFor({ kind: 'onsite', connectClientId: null });
    renderWithProviders(<AppListingEditPage />);

    const picker = page.getByTestId('stub-transfer-picker');
    await expect.element(picker).toBeInTheDocument();
    await expect.element(picker).toBeEnabled();
    expect(page.getByTestId('apps-transfer-blocked').elements()).toHaveLength(0);
  });

  /**
   * 🔴 THE KIND ARM OF THE PREDICATE, pinned against the SERVER's behaviour rather than
   * against a guess. `refusesTransferForConnectClient` requires `kind === 'offsite'`, so
   * an on-site row that somehow carried a client id is still transferable server-side —
   * and the tab must agree with that, not invent a stricter rule of its own. A UI that
   * refused here would block a transfer the server would have allowed.
   *
   * INVARIANT GUARD, labelled: this passes on `origin/main` too (nothing was disabled
   * there). It is here to kill the "drop the kind check" mutation, not as regression
   * coverage for the shipped defect.
   */
  test('a (hypothetical) on-site row carrying a client id is still transferable', async () => {
    state.context = contextFor({ kind: 'onsite', connectClientId: 'oc_onsite' });
    renderWithProviders(<AppListingEditPage />);

    await expect.element(page.getByTestId('stub-transfer-picker')).toBeEnabled();
    expect(page.getByTestId('apps-transfer-blocked').elements()).toHaveLength(0);
  });
});
