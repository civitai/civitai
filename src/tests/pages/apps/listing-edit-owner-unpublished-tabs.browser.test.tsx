import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import { useRouter } from 'next/router';
import { capabilitiesForKind } from '~/shared/constants/app-capabilities.constants';
import type * as TrpcModule from '~/utils/trpc';

/**
 * `/apps/listing/<id>/edit` — THE TAB SET AN OWNER-UNPUBLISHED LISTING ACTUALLY RENDERS.
 *
 * 🔴 THIS FILE EXISTS FOR ONE HOP THAT NO OTHER INSTRUMENT SEES: does the PAGE hand
 * `lastModerationAction` to `editorTabsFor` at all?
 *
 *   - `appListingEditorTabs.test.ts` proves the derivation branches on the field — from a
 *     fixture the test writes itself.
 *   - `app-access.editor-tabs.seam.test.ts` proves the value survives the service's query
 *     and normalisation — and then calls `editorTabsFor` with it, in the TEST.
 *   - Neither renders the page. Delete the `lastModerationAction:` line from
 *     `/apps/listing/[appListingId]/edit` and BOTH stay green while the feature is dark,
 *     because the field is optional (fail-closed) and its absence is not a type error.
 *
 * That is the same shape as #4401's `messageAppOwner` — a live server capability with no
 * caller — and it is the shape this whole change exists to close, so it gets its own guard
 * rather than being assumed.
 *
 * Every panel BODY is stubbed. The subject is which tabs exist, not what is inside them;
 * the bodies have their own suites (`ExternalSubmitForm.ownerUnpublished.browser.test.tsx`,
 * `listing-media-page.browser.test.tsx`).
 */

type AuthoringContext = {
  appListingId: string;
  slug: string;
  name: string;
  status: string;
  kind: 'onsite' | 'offsite';
  appBlockId: string | null;
  connectClientId: string | null;
  lastModerationAction: string | null;
  role: string;
  capabilities: Readonly<Record<string, boolean>>;
};

const state = vi.hoisted(() => ({
  /** The `getAuthoringContext` payload — THE ONLY THING ANY ARM VARIES. */
  context: null as unknown,
  /** `appFeedback.hasAnyForListing` — `null` while the read is in flight. */
  feedback: { hasAny: false } as { hasAny: boolean } | null,
  feedbackError: null as unknown,
  /** Every input the page asked `hasAnyForListing` about. */
  feedbackInputs: [] as unknown[],
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

// 🔴 THE SHARED NAV'S DATA HOOK IS STUBBED, and that is a scoping decision rather than
// convenience. `/apps/listing/[appListingId]/edit` renders `AppsPageLayout`, which calls
// `useAppsNavSections` — a hook with three context/data inputs of its own
// (`useIsClient`, `useCurrentUser`, `blocks.getNavSummary`). Wiring them here would
// make this suite, which is about the listing editor, fail the next time the nav
// gains an input. The ADOPTION is covered where it belongs: structurally in
// `__tests__/appsPageWidths.test.ts` (every rendering /apps page mounts the layout),
// as pixels in `AppsPageLayout.chromeAlignment.browser.test.tsx`, and end-to-end on
// one page in `AppEditPage.browser.test.tsx`.
//
// ⚠️ AN EMPTY SECTION LIST MEANS NO RAIL AT ALL — the `< 2 sections` collapse — so this
// stub also removes the 276px of rail chrome from the tree. That is the right scoping
// for a suite about the editor's own body, and it is why the stub returns `[]` rather
// than a placeholder element: the layout, not the nav, decides whether the rail exists.
vi.mock('~/components/Apps/useAppsNavSections', () => ({
  useAppsNavSections: () => [],
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 10, username: 'owner' }),
}));

vi.mock('~/components/AppLayout/NotFound', () => ({
  NotFound: () => <div data-testid="not-found">Not found</div>,
}));

// `Meta` reads the app-wide BrowserRouter context, which `renderWithProviders` deliberately
// does not mount. It contributes nothing to this suite's subject.
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

// Panel bodies — stubbed so this file is about the TAB LIST and so their module graphs stay
// out of the browser build (the collaborators panel reaches a Meilisearch client that reads
// its host URL AT IMPORT TIME and throws).
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
vi.mock('~/components/Apps/AppCollaboratorsPanel', () => ({
  AppCollaboratorsPanel: () => <div data-testid="stub-collaborators" />,
}));
vi.mock('~/components/Apps/ListingPublishingPanel', () => ({
  ListingPublishingPanel: () => <div data-testid="stub-publishing" />,
}));
vi.mock('~/components/Apps/ListingHistoryPanel', () => ({
  ListingHistoryPanel: () => <div data-testid="stub-history" />,
}));
vi.mock('~/components/Apps/AppFeedbackInboxPanel', () => ({
  AppFeedbackInboxPanel: ({ appListingId }: { appListingId: string }) => (
    <div data-testid="stub-feedback">{appListingId}</div>
  ),
}));

// Spread the REAL module and override only `trpc` (per `local-rules/no-wholesale-module-mock`):
// a hand-written replacement silently drops any export a transitive importer needs, and the
// whole file then fails to load as "0 tests collected" — green for the worst possible reason.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  return {
    ...actual,
    trpc: makeTrpcProxy({
      'appListings.getAuthoringContext': {
        useQuery: () => ({
          data: state.context,
          isLoading: state.context == null,
          error: null,
        }),
      },
      'appFeedback.hasAnyForListing': {
        useQuery: (input: unknown) => {
          state.feedbackInputs.push(input);
          return {
            data: state.feedbackError ? undefined : state.feedback ?? undefined,
            isLoading: state.feedback == null && !state.feedbackError,
            error: state.feedbackError,
          };
        },
      },
    }),
  };
});

const AppListingEditPage = (await import('~/pages/apps/listing/[appListingId]/edit')).default;

const LISTING_ID = 'apl_repair';

function contextFor(over: Partial<AuthoringContext>): AuthoringContext {
  const kind = over.kind ?? 'onsite';
  return {
    appListingId: LISTING_ID,
    slug: 'my-app',
    name: 'My App',
    status: 'removed',
    kind,
    appBlockId: kind === 'onsite' ? 'ab_1' : null,
    connectClientId: null,
    lastModerationAction: null,
    role: 'owner',
    capabilities: capabilitiesForKind(kind),
    ...over,
  };
}

function openListing(tab?: string) {
  const router = (useRouter as unknown as () => { query: Record<string, string> })();
  router.query.appListingId = LISTING_ID;
  if (tab) router.query.tab = tab;
  else delete router.query.tab;
}

/** The rendered tab strip, in DOM order. Read off the DOM, never off a captured prop. */
function renderedTabs(): string[] {
  return page
    .getByTestId(/^apps-edit-tab-/)
    .elements()
    .map((el) => (el.getAttribute('data-testid') ?? '').replace('apps-edit-tab-', ''));
}

beforeEach(() => {
  state.context = null;
  state.feedback = { hasAny: false };
  state.feedbackError = null;
  state.feedbackInputs = [];
  state.flags = { appBlocks: true };
  openListing();
});

describe('🔴 the page hands `lastModerationAction` to the tab derivation', () => {
  test('🔴 an OWNER-UNPUBLISHED listing renders the Details and Media tabs', async () => {
    state.context = contextFor({ lastModerationAction: 'owner-unpublish' });
    renderWithProviders(<AppListingEditPage />);

    await expect.element(page.getByTestId('apps-edit-tab-details')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-edit-tab-media')).toBeInTheDocument();
    // Order is asserted too — the strip is what the owner scans, and `details` must be the
    // landing tab (a bare `/edit` resolves to DEFAULT_EDITOR_TAB when it is allowed).
    expect(renderedTabs()).toEqual(['details', 'media', 'publishing', 'history']);
  });

  test('🔴 a MODERATOR-DELISTED listing renders NEITHER — same payload, one field apart', async () => {
    // `other` is what `normalizeLastModerationAction` sends for every moderator verb, so
    // this is the shape a real `delist`/`purge` produces on the wire. This is the arm that
    // fails if someone widens `AUTHORABLE_LISTING_STATUSES` instead of branching.
    state.context = contextFor({ lastModerationAction: 'other' });
    renderWithProviders(<AppListingEditPage />);

    await expect.element(page.getByTestId('apps-edit-tab-publishing')).toBeInTheDocument();
    expect(page.getByTestId('apps-edit-tab-details').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-edit-tab-media').elements()).toHaveLength(0);
    // 🔴 The Forgejo-write surface, named. Accepting an invite still mints repo `write`.
    expect(page.getByTestId('apps-edit-tab-collaborators').elements()).toHaveLength(0);
    expect(renderedTabs()).toEqual(['publishing', 'history']);
  });

  test('🔴 a removed listing with NO moderation event fails closed', async () => {
    state.context = contextFor({ lastModerationAction: null });
    renderWithProviders(<AppListingEditPage />);

    await expect.element(page.getByTestId('apps-edit-tab-publishing')).toBeInTheDocument();
    expect(renderedTabs()).toEqual(['publishing', 'history']);
  });

  test('🔴 the repair state does NOT open Collaborators, Manifest or Earnings', async () => {
    // Every one of the three is available on this fixture's kind + block id, so their
    // absence is the branch split alone and not a collapsed payload. The two tabs that DO
    // render are the control that the page is not simply empty.
    state.context = contextFor({ lastModerationAction: 'owner-unpublish' });
    renderWithProviders(<AppListingEditPage />);

    await expect.element(page.getByTestId('apps-edit-tab-details')).toBeInTheDocument();
    for (const tab of ['collaborators', 'manifest', 'earnings']) {
      expect(page.getByTestId(`apps-edit-tab-${tab}`).elements(), tab).toHaveLength(0);
    }
  });

  test('🔴 a `?tab=collaborators` deep link on a repaired listing lands on Details', async () => {
    // The withheld tab must not be reachable by URL either — and it lands somewhere REAL,
    // not on a blank panel. A different answer from the delisted case, which has no
    // `details` to fall back to.
    openListing('collaborators');
    state.context = contextFor({ lastModerationAction: 'owner-unpublish' });
    renderWithProviders(<AppListingEditPage />);

    await expect.element(page.getByTestId('apps-edit-panel-details')).toBeInTheDocument();
    expect(page.getByTestId('apps-edit-panel-collaborators').elements()).toHaveLength(0);
  });

  test('the payload reaches the page and different payloads render differently (control)', async () => {
    // 🔴 THE FAKE'S OWN CONTROL, read through a fact this change does not touch: an APPROVED
    // listing renders the full strip. Without it, every arm above could be passing because
    // the mock serves a frozen payload and the page renders one fixed set.
    state.context = contextFor({ status: 'approved', lastModerationAction: null });
    renderWithProviders(<AppListingEditPage />);

    await expect.element(page.getByTestId('apps-edit-tab-collaborators')).toBeInTheDocument();
    expect(renderedTabs()).toEqual([
      'details',
      'media',
      'manifest',
      'earnings',
      'collaborators',
      'publishing',
      'history',
    ]);
  });
});

/**
 * 🔴 THE FEEDBACK TAB EXISTS ONLY ONCE THE LISTING HAS FEEDBACK (operator decision, 2026-10-09).
 * The page must ask `appFeedback.hasAnyForListing` about THIS listing and hand the answer to the
 * tab derivation; every arm below varies only that answer.
 */
describe('🔴 the Feedback tab follows `hasAnyForListing`', () => {
  const live = () => contextFor({ status: 'approved', lastModerationAction: null });

  test('🔴 no feedback: no tab', async () => {
    state.context = live();
    renderWithProviders(<AppListingEditPage />);

    await expect.element(page.getByTestId('apps-edit-tab-details')).toBeInTheDocument();
    expect(page.getByTestId('apps-edit-tab-feedback').elements()).toHaveLength(0);
    expect(state.feedbackInputs.at(-1)).toEqual({ appListingId: LISTING_ID });
  });

  test('🔴 one row: the tab, LAST, and the rest of the strip unchanged', async () => {
    state.context = live();
    state.feedback = { hasAny: true };
    renderWithProviders(<AppListingEditPage />);

    await expect.element(page.getByTestId('apps-edit-tab-feedback')).toBeInTheDocument();
    expect(renderedTabs()).toEqual([
      'details',
      'media',
      'manifest',
      'earnings',
      'collaborators',
      'publishing',
      'history',
      'feedback',
    ]);
  });

  test('🔴 `?tab=feedback` with feedback opens the inbox for THIS listing (the /apps/build badge link)', async () => {
    openListing('feedback');
    state.context = contextFor({ role: 'editor', kind: 'offsite', lastModerationAction: 'other' });
    state.feedback = { hasAny: true };
    renderWithProviders(<AppListingEditPage />);

    await expect.element(page.getByTestId('stub-feedback')).toHaveTextContent(LISTING_ID);
    expect(renderedTabs()).toEqual(['history', 'feedback']);
  });

  test('🔴 `?tab=feedback` with NO feedback falls back to the default tab, not an empty inbox', async () => {
    openListing('feedback');
    state.context = live();
    renderWithProviders(<AppListingEditPage />);

    await expect.element(page.getByTestId('apps-edit-panel-details')).toBeInTheDocument();
    expect(page.getByTestId('stub-feedback').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-edit-panel-feedback').elements()).toHaveLength(0);
  });

  test('a failed presence read hides the tab rather than blocking the page', async () => {
    openListing('feedback');
    state.context = live();
    state.feedback = null;
    state.feedbackError = { message: 'nope', data: { code: 'INTERNAL_SERVER_ERROR' } };
    renderWithProviders(<AppListingEditPage />);

    await expect.element(page.getByTestId('apps-edit-panel-details')).toBeInTheDocument();
    expect(page.getByTestId('apps-edit-tab-feedback').elements()).toHaveLength(0);
  });

  test('the strip waits for the presence read, so a deep link never mounts the default panel first', async () => {
    openListing('feedback');
    state.context = live();
    state.feedback = null;
    renderWithProviders(<AppListingEditPage />);

    // Positive control: the page rendered its loading state (so the absences below are read off
    // a rendered page, not an empty tree).
    await expect.poll(() => document.querySelector('.mantine-Loader-root')).not.toBeNull();
    expect(page.getByTestId(/^apps-edit-tab-/).elements()).toHaveLength(0);
    expect(page.getByTestId('apps-edit-panel-details').elements()).toHaveLength(0);
  });
});
