import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
// After `makeTrpcProxy`: these modules import `~/utils/trpc`, whose mock factory reads it.
import { openListingModerationHistory } from '~/components/Apps/ListingModerationHistoryModal';
import { FixedSessionProvider } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';

/**
 * "Retry cut" on a listing's moderation history (#9926), opened the way every moderator surface
 * opens it: `openListingModerationHistory` through the REAL global dialog store and
 * `DialogProvider`. Only the tRPC boundary is replaced.
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

type RetryVars = { appListingId: string };
type HistoryInput = { appListingId: string; limit: number };
type RetryMutate = (vars: RetryVars) => void;
type HistoryRead = (input: HistoryInput) => void;

const mocks = vi.hoisted(() => ({
  retry: vi.fn<RetryMutate>(),
  historyInput: vi.fn<HistoryRead>(),
  invalidate: vi.fn(async () => undefined),
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ appBlocks: true }),
}));

// Spread the real module: the modal also imports `showWarningNotification`, and a one-key factory
// fails the whole file at the ESM link step.
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showSuccessNotification: vi.fn(),
  showWarningNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy(
    {
      'appListings.listModerationEvents': {
        useQuery: (input: HistoryInput) => {
          mocks.historyInput(input);
          return { data: { items: EVENTS }, isLoading: false, error: null };
        },
      },
      'appListings.retryConnectOfflineCut': {
        useMutation: (opts?: {
          onSuccess?: (data: { appListingId: string; outcome: 'cut'; deleted: number }) => unknown;
        }) => ({
          mutate: (vars: RetryVars) => {
            mocks.retry(vars);
            void opts?.onSuccess?.({ appListingId: vars.appListingId, outcome: 'cut', deleted: 2 });
          },
          isPending: false,
        }),
      },
    },
    // Stable, so the assertion reads the spy the modal called.
    {
      useUtils: () => ({
        appListings: { listModerationEvents: { invalidate: mocks.invalidate } },
      }),
    }
  ),
}));

beforeEach(() => {
  useDialogStore.getState().closeAll();
  mocks.retry.mockClear();
  mocks.historyInput.mockClear();
  mocks.invalidate.mockClear();
});

describe('ListingModerationHistoryModal — Retry cut', () => {
  test('a moderator clicking Retry cut retries the cut for the listing the history was opened for', async () => {
    // The history is moderator-only; render the dialog host inside a moderator session.
    renderWithProviders(
      <FixedSessionProvider user={{ id: 1, username: 'mod', isModerator: true }}>
        <DialogProvider />
      </FixedSessionProvider>
    );
    openListingModerationHistory(LISTING);

    const retry = page.getByTestId('apps-mod-event-retry-cut-evt-failed-new');
    await expect.element(retry).toBeVisible();
    // The history was read for the listing the opener named, through the dialog store's props.
    expect(mocks.historyInput).toHaveBeenCalledWith({
      appListingId: LISTING.appListingId,
      limit: 50,
    });
    expect(mocks.retry).not.toHaveBeenCalled();

    await retry.click();

    expect(mocks.retry).toHaveBeenCalledTimes(1);
    expect(mocks.retry).toHaveBeenCalledWith({ appListingId: LISTING.appListingId });
    // Either outcome is a new history row, so the list is refetched.
    await vi.waitFor(() => expect(mocks.invalidate).toHaveBeenCalledTimes(1));
  });
});
