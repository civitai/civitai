import { cleanNotifications, cleanNotificationsQueue, Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCReact } from '@trpc/react-query';
import { createTRPCClient, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { openListingModerationHistory } from '~/components/Apps/ListingModerationHistoryModal';
import { FixedSessionProvider } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import { FeatureFlagsProvider } from '~/providers/FeatureFlagsProvider';
import type { AppRouter } from '~/server/routers';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * "Retry cut" on a listing's moderation history (#9926), opened the way every moderator surface
 * opens it: `openListingModerationHistory` through the REAL global dialog store and
 * `DialogProvider`, under the real `FeatureFlagsProvider`, the real `~/utils/trpc` hooks and the
 * real notifications. Only the network is replaced: a tRPC link answers the two procedures.
 *
 * The listing id, the event ids and the actor id are pairwise distinct, so a click that sent an
 * event id (or any id but the listing's) cannot satisfy the call assertion.
 */

const LISTING = { appListingId: 'listing-cut-9', slug: 'cut-app' };

const event = (id: string, action: string, createdAt: string, over: object = {}) => ({
  id,
  appListingId: LISTING.appListingId,
  slug: LISTING.slug,
  action,
  reason: null,
  detail: null,
  before: null,
  after: null,
  reportId: null,
  createdAt,
  actor: { id: 7, username: 'mod', image: null },
  ...over,
});

const FAILED = event('evt-failed-new', 'offline-cut-failed', '2026-11-20T12:00:00Z', {
  detail: 'refresh key delete timed out',
  after: { clientId: 'client-a' },
});
const DELIST = event('evt-delist', 'delist', '2026-11-20T11:59:00Z', {
  reason: 'policy violation',
  before: { status: 'approved' },
  after: { status: 'removed' },
});
// The row the server records when the retried cut succeeds.
const CUT = event('evt-cut-retry', 'offline-cut', '2026-11-20T12:05:00Z', {
  after: { clientId: 'client-a' },
});

/** What the network saw, and what it answers. */
const io = {
  historyReads: [] as unknown[],
  retries: [] as unknown[],
  history: (): unknown => ({ items: [FAILED, DELIST] }),
};

const link: TRPCLink<AppRouter> =
  () =>
  ({ op }) =>
    observable((observer) => {
      const answer = (): unknown => {
        if (op.path === 'appListings.listModerationEvents') {
          io.historyReads.push(op.input);
          return io.history();
        }
        if (op.path === 'appListings.retryConnectOfflineCut') {
          io.retries.push(op.input);
          // The retry is recorded as a new, newest history row.
          io.history = () => ({ items: [CUT, FAILED, DELIST] });
          return { appListingId: LISTING.appListingId, outcome: 'cut', deleted: 2 };
        }
        return undefined;
      };
      const data = answer();
      // An unscripted procedure never answers rather than resolving empty.
      if (data === undefined) return;
      observer.next({ result: { type: 'data', data } });
      observer.complete();
    });

const { Provider: TRPCProvider } = createTRPCReact<AppRouter>();

function Network({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = createTRPCClient<AppRouter>({ links: [link] });
  return (
    <TRPCProvider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </TRPCProvider>
  );
}

beforeEach(() => {
  useDialogStore.getState().closeAll();
  cleanNotifications();
  cleanNotificationsQueue();
  io.historyReads = [];
  io.retries = [];
  io.history = () => ({ items: [FAILED, DELIST] });
});

afterEach(() => {
  cleanNotifications();
  cleanNotificationsQueue();
});

describe('ListingModerationHistoryModal — Retry cut', () => {
  test('a moderator clicking Retry cut retries the cut for the listing the history was opened for', async () => {
    // The history is moderator-only; render the dialog host inside a moderator session.
    renderWithProviders(
      <Network>
        <FeatureFlagsProvider flags={{ appBlocks: true } as FeatureAccess}>
          <FixedSessionProvider user={{ id: 1, username: 'mod', isModerator: true }}>
            <Notifications />
            <DialogProvider />
          </FixedSessionProvider>
        </FeatureFlagsProvider>
      </Network>
    );
    openListingModerationHistory(LISTING);

    const retry = page.getByTestId('apps-mod-event-retry-cut-evt-failed-new');
    await expect.element(retry).toBeVisible();
    // The history was read for the listing the opener named, through the dialog store's props.
    expect(io.historyReads).toEqual([{ appListingId: LISTING.appListingId, limit: 50 }]);
    expect(io.retries).toEqual([]);

    await retry.click();

    await vi.waitFor(() => expect(io.retries).toHaveLength(1));
    expect(io.retries).toEqual([{ appListingId: LISTING.appListingId }]);
    await expect
      .element(page.getByText('Offline access cut (2 refresh tokens deleted).'))
      .toBeVisible();
    // Either outcome is a new history row, so the list is refetched: the newest cut row is now a
    // success, so the button is gone.
    await vi.waitFor(() => expect(io.historyReads).toHaveLength(2));
    await expect.element(page.getByText('refresh key delete timed out')).toBeVisible();
    await expect.element(retry).not.toBeInTheDocument();
    expect(io.retries).toHaveLength(1);
  });
});
