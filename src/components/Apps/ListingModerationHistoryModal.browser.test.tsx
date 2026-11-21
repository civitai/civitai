import superjson from 'superjson';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { openListingModerationHistory } from '~/components/Apps/ListingModerationHistoryModal';
import { FixedSessionProvider } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import { FeatureFlagsProvider } from '~/providers/FeatureFlagsProvider';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { queryClient, trpc } from '~/utils/trpc';

/**
 * "Retry cut" on a listing's moderation history (#9926), opened the way every moderator surface
 * opens it: `openListingModerationHistory` through the REAL global dialog store and
 * `DialogProvider`, the real tRPC client and the real feature-flag provider. Only `fetch` (the
 * network) is replaced.
 *
 * The listing id, the event ids and the actor id are pairwise distinct, so a click that sent an
 * event id (or any id but the listing's) cannot satisfy the call assertion.
 */

const LISTING = { appListingId: 'listing-cut-9', slug: 'cut-app' };

const EVENTS = [
  {
    id: 'evt-failed-new',
    appListingId: LISTING.appListingId,
    slug: LISTING.slug,
    action: 'offline-cut-failed',
    reason: null,
    detail: 'refresh key delete timed out',
    before: null,
    after: { clientId: 'client-a' },
    reportId: null,
    createdAt: '2026-11-20T12:00:00Z',
    actor: { id: 7, username: 'mod', image: null },
  },
  {
    id: 'evt-delist',
    appListingId: LISTING.appListingId,
    slug: LISTING.slug,
    action: 'delist',
    reason: 'policy violation',
    detail: null,
    before: { status: 'approved' },
    after: { status: 'removed' },
    reportId: null,
    createdAt: '2026-11-20T11:59:00Z',
    actor: { id: 7, username: 'mod', image: null },
  },
];

type Call = { procedure: string; input: unknown };

const TRPC_PREFIX = '/api/trpc/';

/** The tRPC wire is superjson: `{ json, meta? }` in the query string (GET) or the body (POST). */
function decodeCall(url: URL, init: RequestInit | undefined): Call {
  const raw = init?.method === 'POST' ? String(init.body) : url.searchParams.get('input');
  return {
    procedure: url.pathname.slice(TRPC_PREFIX.length),
    input: raw ? superjson.deserialize(JSON.parse(raw)) : undefined,
  };
}

const calls: Call[] = [];
const callsTo = (procedure: string) => calls.filter((c) => c.procedure === procedure);

function stubNetwork() {
  const realFetch = globalThis.fetch.bind(globalThis);
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, window.location.href);
    if (!url.pathname.startsWith(TRPC_PREFIX)) return realFetch(input, init);
    const call = decodeCall(url, init);
    calls.push(call);
    const data =
      call.procedure === 'appListings.listModerationEvents'
        ? { items: EVENTS }
        : call.procedure === 'appListings.retryConnectOfflineCut'
        ? { appListingId: LISTING.appListingId, outcome: 'cut', deleted: 2 }
        : null;
    if (data === null) throw new Error(`unscripted tRPC call: ${call.procedure}`);
    return new Response(JSON.stringify({ result: { data: superjson.serialize(data) } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

// `withTRPC` supplies the real client's provider; the moderator session and the `appBlocks` flag
// the modal gates on are the real providers too.
const Host = trpc.withTRPC(function Host() {
  return (
    <FixedSessionProvider user={{ id: 1, username: 'mod', isModerator: true }}>
      <FeatureFlagsProvider flags={{ appBlocks: true } as FeatureAccess}>
        <DialogProvider />
      </FeatureFlagsProvider>
    </FixedSessionProvider>
  );
});

beforeEach(() => {
  useDialogStore.getState().closeAll();
  queryClient.clear();
  calls.length = 0;
});

describe('ListingModerationHistoryModal — Retry cut', () => {
  test('a moderator clicking Retry cut retries the cut for the listing the history was opened for', async () => {
    const fetchSpy = stubNetwork();
    try {
      renderWithProviders(<Host />);
      openListingModerationHistory(LISTING);

      const retry = page.getByTestId('apps-mod-event-retry-cut-evt-failed-new');
      await expect.element(retry).toBeVisible();
      // The history was read for the listing the opener named, through the dialog store's props.
      expect(callsTo('appListings.listModerationEvents')).toEqual([
        {
          procedure: 'appListings.listModerationEvents',
          input: { appListingId: LISTING.appListingId, limit: 50 },
        },
      ]);
      expect(callsTo('appListings.retryConnectOfflineCut')).toHaveLength(0);

      await retry.click();

      await vi.waitFor(() =>
        expect(callsTo('appListings.retryConnectOfflineCut')).toEqual([
          {
            procedure: 'appListings.retryConnectOfflineCut',
            input: { appListingId: LISTING.appListingId },
          },
        ])
      );
      // Either outcome is a new history row, so the list is refetched.
      await vi.waitFor(() => expect(callsTo('appListings.listModerationEvents')).toHaveLength(2));
      // ...and the refetch follows the retry, so it is the invalidation and not a focus or remount.
      const order = calls.map((c) => c.procedure);
      expect(order.lastIndexOf('appListings.listModerationEvents')).toBeGreaterThan(
        order.indexOf('appListings.retryConnectOfflineCut')
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
