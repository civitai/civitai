import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';
import type { ListingHistoryEntry } from './ListingHistoryPanel';

/**
 * The authoring page's **History** tab — the publish-request stream that MOVED off the
 * `/apps/mine` row.
 *
 * 🔴 EVERY CASE BELOW WAS ALREADY GREEN SOMEWHERE, ON THE SURFACE THAT NO LONGER HAS IT.
 * These are the `/apps/mine` nested-history assertions, re-pointed at the panel that now
 * owns them — the two disjoint streams, the empty state, the failed read, and the three
 * reasons a Withdraw button is withheld. Stating that plainly matters for the red/green
 * matrix: as BEHAVIOUR none of it is new, so none of it is evidence that the move worked.
 * What IS new, and what carries the move, is on the two ends of it —
 * `MyAppsBody.browser.test.tsx`'s "the container issues NO listingHistory query at all"
 * (red at base, where the row does issue one) and `appListingEditorTabs.test.ts`'s history
 * tab cases (red at base, where no such tab exists). Re-homed coverage is coverage kept,
 * not coverage earned, and it is labelled that way rather than counted as the latter.
 *
 * 🔴 WHAT IS MOCK-SHADOWED. The data layer entirely. The `component` project loads no CSS,
 * so nothing here is a claim about layout.
 */

const mocks = vi.hoisted(() => ({
  entries: [] as unknown[],
  loading: false,
  error: null as string | null,
  /** Every `listingHistory.useQuery(input, opts)` call, in order. */
  queryCalls: [] as Array<{ appListingId: string }>,
  /** `[procedureName, input]` for every withdraw fired, in order. */
  calls: [] as Array<[string, unknown]>,
  appBlocksFlag: true,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: mocks.appBlocksFlag, appBlocksAuthor: true }),
}));

type MutationOpts = { onSuccess?: (data: unknown) => unknown; onError?: (e: unknown) => unknown };
function mutationStub(name: string) {
  return {
    useMutation: (opts?: MutationOpts) => ({
      mutate: (input: unknown) => {
        mocks.calls.push([name, input]);
        void opts?.onSuccess?.(undefined);
      },
      isPending: false,
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
      },
    }),
    appListings: {
      listingHistory: {
        useQuery: (input: { appListingId: string }) => {
          mocks.queryCalls.push(input);
          return {
            data: mocks.entries,
            isLoading: mocks.loading,
            error: mocks.error ? { message: mocks.error } : null,
          };
        },
      },
      // 🔴 The two withdraw procedures are stubbed with DISTINCT recorded names, so the
      // source-keyed routing assertion cannot pass by hitting the wrong one.
      withdrawExternalRequest: mutationStub('withdrawExternalRequest'),
    },
    blocks: { withdrawPublishRequest: mutationStub('withdrawPublishRequest') },
  },
}));

vi.mock('~/utils/notifications', () => ({
  showErrorNotification: vi.fn(),
  showSuccessNotification: vi.fn(),
}));

const { ListingHistoryPanel, ListingHistoryPanelView } = await import('./ListingHistoryPanel');

/**
 * Fixtures are pairwise distinct on every dimension an assertion names — id, source,
 * status, version — so a mutant that hardcodes any one literal cannot pass by matching a
 * fixture that could only ever have produced that value.
 */
function entry(over: Partial<ListingHistoryEntry> & { id: string }): ListingHistoryEntry {
  return {
    source: 'version',
    status: 'approved',
    version: '1.0.0',
    submittedAt: '2026-07-01T00:00:00Z',
    reviewedAt: null,
    rejectionReason: null,
    approvalNotes: null,
    changelog: null,
    deployState: null,
    // Default to the SUBMITTER's view so the fixture is not silently unwithdrawable; the
    // cases that care about the collaborator/flag branches set it explicitly.
    canWithdraw: over.status === 'pending',
    ...over,
  };
}

beforeEach(() => {
  mocks.entries = [];
  mocks.loading = false;
  mocks.error = null;
  mocks.queryCalls = [];
  mocks.calls = [];
  mocks.appBlocksFlag = true;
});

describe('the stream', () => {
  test('BOTH publish-request streams appear, tagged by source, without duplication', async () => {
    // The two tables are disjoint event streams over one app — see
    // `app-listing-history.service`'s header. A version bump and a listing edit are
    // different events and must BOTH show.
    renderWithProviders(
      <ListingHistoryPanelView
        entries={[
          entry({ id: 'blk_1', source: 'version', status: 'approved', version: '4.2.0' }),
          entry({ id: 'lst_1', source: 'listing', status: 'pending', version: null }),
        ]}
      />
    );
    const blk = page.getByTestId('apps-history-entry-blk_1');
    await expect.element(blk).toBeInTheDocument();
    expect(blk.element().getAttribute('data-history-source')).toBe('version');
    await expect.element(blk).toHaveTextContent('4.2.0');
    const lst = page.getByTestId('apps-history-entry-lst_1');
    expect(lst.element().getAttribute('data-history-source')).toBe('listing');
    await expect.element(lst).toHaveTextContent(/listing edit/i);
    // One element each — a merged read that failed to distinguish the streams would
    // render the same event twice.
    expect(blk.elements()).toHaveLength(1);
    expect(lst.elements()).toHaveLength(1);
  });

  test('🔴 a WITHDRAWN request on a live app is still in the stream', async () => {
    // The half of `/apps/mine`'s "a withdrawn submission keeps the app ACTIVE" case that
    // moved here with the panel. A submission status is not a listing status: the app is
    // live, the author merely pulled one request, and the record must stay visible.
    renderWithProviders(
      <ListingHistoryPanelView
        entries={[
          entry({ id: 'req_wd', source: 'listing', status: 'withdrawn', version: null }),
          entry({ id: 'req_ok', source: 'version', status: 'approved', version: '2.1.0' }),
        ]}
      />
    );
    await expect
      .element(page.getByTestId('apps-history-status-req_wd'))
      .toHaveTextContent(/withdrawn/i);
    await expect.element(page.getByTestId('apps-history-entry-req_ok')).toBeInTheDocument();
  });

  test('🔴 a REJECTION REASON reaches the reader — it is the only actionable thing here', async () => {
    renderWithProviders(
      <ListingHistoryPanelView
        entries={[
          entry({ id: 'rej_1', status: 'rejected', rejectionReason: 'Icon is 32px, needs 256px' }),
        ]}
      />
    );
    await expect
      .element(page.getByTestId('apps-history-notes-rej_1'))
      .toHaveTextContent('Icon is 32px, needs 256px');
  });

  test('an app with no history says so rather than rendering an empty box', async () => {
    renderWithProviders(<ListingHistoryPanelView entries={[]} />);
    await expect.element(page.getByTestId('apps-history-empty')).toBeInTheDocument();
  });

  test('a failed history read shows an error, never an empty state', async () => {
    renderWithProviders(<ListingHistoryPanelView entries={[]} errorMessage="nope" />);
    await expect.element(page.getByTestId('apps-history-error')).toHaveTextContent('nope');
    // 🔴 A failed read is NOT "no submissions". Conflating them is the silent-zero lie the
    // orphan group on `/apps/mine` exists to stop telling, applied to this panel.
    expect(page.getByTestId('apps-history-empty').query()).toBeNull();
  });

  test('an in-flight read shows the loader, not the empty state', async () => {
    renderWithProviders(<ListingHistoryPanelView entries={[]} loading />);
    await expect.element(page.getByTestId('apps-history-loading')).toBeInTheDocument();
    expect(page.getByTestId('apps-history-empty').query()).toBeNull();
  });
});

describe('🔴 Withdraw is not offered to people the server will refuse', () => {
  /**
   * Both withdraw procs are SUBMITTER-scoped (`withdrawExternalRequest` and
   * `withdrawRequest` each throw NOT_OWNED unless `submittedByUserId === userId`). An
   * accepted collaborator, a transfer recipient and a moderator-claimed owner — the three
   * populations the author surfaces exist to serve — would otherwise get a button that only
   * ever red-toasts. The server sends its own verdict as `canWithdraw`.
   */
  test('a PENDING entry the viewer did not submit shows NO button', async () => {
    renderWithProviders(
      <ListingHistoryPanelView
        entries={[entry({ id: 'req_theirs', status: 'pending', canWithdraw: false })]}
        onWithdraw={() => undefined}
      />
    );
    await expect.element(page.getByTestId('apps-history-entry-req_theirs')).toBeInTheDocument();
    expect(page.getByTestId('apps-history-withdraw-req_theirs').elements()).toHaveLength(0);
  });

  test('the same entry DOES show it for the submitter, and only on a PENDING one', async () => {
    const seen: string[] = [];
    renderWithProviders(
      <ListingHistoryPanelView
        entries={[
          entry({ id: 'pend_1', status: 'pending', canWithdraw: true }),
          entry({ id: 'appr_1', status: 'approved', canWithdraw: false }),
        ]}
        onWithdraw={(e) => seen.push(e.id)}
      />
    );
    const btn = page.getByTestId('apps-history-withdraw-pend_1');
    await expect.element(btn).toBeInTheDocument();
    expect(page.getByTestId('apps-history-withdraw-appr_1').elements()).toHaveLength(0);
    await userEvent.click(btn.element());
    expect(seen).toEqual(['pend_1']);
  });

  /**
   * 🔴 THE FLAG MISMATCH. `blocks.withdrawPublishRequest` carries `enforceAppBlocksFlag`;
   * the authoring page and its reads gate on `appBlocksAuthor` only. With the author flag
   * on and the store flag off the page renders, history loads, and the VERSION half of the
   * button 403s — while the off-site half (`withdrawExternalRequest`, no flag) is fine.
   */
  test('🔴 with the store flag off, the VERSION withdraw is hidden and the LISTING one is not', async () => {
    renderWithProviders(
      <ListingHistoryPanelView
        withdrawEnabled={false}
        entries={[
          entry({ id: 'ver_1', source: 'version', status: 'pending', canWithdraw: true }),
          entry({
            id: 'lst_1',
            source: 'listing',
            status: 'pending',
            version: null,
            canWithdraw: true,
          }),
        ]}
        onWithdraw={() => undefined}
      />
    );
    await expect.element(page.getByTestId('apps-history-entry-ver_1')).toBeInTheDocument();
    expect(page.getByTestId('apps-history-withdraw-ver_1').elements()).toHaveLength(0);
    // The off-site sibling proc has no such gate, so its control stays.
    await expect.element(page.getByTestId('apps-history-withdraw-lst_1')).toBeInTheDocument();
  });
});

describe('the container — one listing-keyed read, and the source-keyed withdraw routing', () => {
  test('🔴 it queries listingHistory for THE LISTING IT WAS GIVEN, eagerly', async () => {
    mocks.entries = [entry({ id: 'req_c1', version: '9.9.9' })];
    renderWithProviders(<ListingHistoryPanel appListingId="apl_container_z7" />);
    await expect.element(page.getByTestId('apps-history-entry-req_c1')).toBeInTheDocument();

    // 🔴 NOT LAZY, unlike the `/apps/mine` row it replaces — and that is the point of the
    // move rather than an oversight. The row was one of dozens on a list page, so its
    // history had to wait for a disclosure click; this panel IS the tab the caller opened,
    // so deferring it behind a second interaction would be a worse page. The id is asserted
    // rather than just the call count: a container that ignored its prop and queried `''`
    // would render an empty stream that looks exactly like an app with no history.
    expect(mocks.queryCalls.map((c) => c.appListingId)).toEqual(
      Array(mocks.queryCalls.length).fill('apl_container_z7')
    );
    expect(mocks.queryCalls.length).toBeGreaterThan(0);
  });

  /**
   * 🔴 THE WITHDRAW MUTATION IS CHOSEN BY THE ENTRY'S OWN `source`. The two streams live in
   * different tables with different procs — sending a listing-revision id to the block proc
   * (or the reverse) is a guaranteed NOT_FOUND, and both buttons look identical.
   */
  test('🔴 a VERSION entry withdraws through the block proc', async () => {
    mocks.entries = [
      entry({ id: 'ver_k3', source: 'version', status: 'pending', canWithdraw: true }),
    ];
    renderWithProviders(<ListingHistoryPanel appListingId="apl_route_1" />);
    const btn = page.getByTestId('apps-history-withdraw-ver_k3');
    await expect.element(btn).toBeInTheDocument();
    await userEvent.click(btn.element());
    // The WHOLE call list, so a stray call to the sibling proc fails here.
    expect(mocks.calls).toEqual([['withdrawPublishRequest', { publishRequestId: 'ver_k3' }]]);
  });

  test('🔴 a LISTING entry withdraws through the listing proc — a different id AND a different proc', async () => {
    mocks.entries = [
      entry({
        id: 'lst_m8',
        source: 'listing',
        status: 'pending',
        version: null,
        canWithdraw: true,
      }),
    ];
    renderWithProviders(<ListingHistoryPanel appListingId="apl_route_2" />);
    const btn = page.getByTestId('apps-history-withdraw-lst_m8');
    await expect.element(btn).toBeInTheDocument();
    await userEvent.click(btn.element());
    expect(mocks.calls).toEqual([['withdrawExternalRequest', { publishRequestId: 'lst_m8' }]]);
  });

  test('🔴 the container passes the store flag through to the version-withdraw gate', async () => {
    mocks.appBlocksFlag = false;
    mocks.entries = [
      entry({ id: 'ver_flag', source: 'version', status: 'pending', canWithdraw: true }),
      entry({
        id: 'lst_flag',
        source: 'listing',
        status: 'pending',
        version: null,
        canWithdraw: true,
      }),
    ];
    renderWithProviders(<ListingHistoryPanel appListingId="apl_flag_c" />);
    // Positive control first: the panel really mounted and really rendered both entries, so
    // the missing button below is a fact about the gate rather than about an empty render.
    await expect.element(page.getByTestId('apps-history-entry-ver_flag')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-history-withdraw-lst_flag')).toBeInTheDocument();
    expect(page.getByTestId('apps-history-withdraw-ver_flag').elements()).toHaveLength(0);
  });
});
