import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as TrpcModule from '~/utils/trpc';
import {
  INBOX_EMPTY_MESSAGE,
  INBOX_EMPTY_OFFSITE_NOTE,
  INBOX_FILTER_EMPTY_MESSAGE,
  INBOX_NO_ACCESS_MESSAGE,
  INBOX_STALE_MESSAGE,
} from '~/components/Apps/appFeedbackInbox';

/**
 * The decisions are pinned in `appFeedbackInbox.test.ts` (node `unit`); this file pins that the
 * panel actually wires them.
 */

type Row = {
  id: number;
  message: string;
  createdAt: Date;
  reporter: { id: number; username: string | null };
  appBlockVersion: string | null;
  appBlockSha: string | null;
  surface: 'slot' | 'page' | null;
  ownerStatus: 'acknowledged' | 'resolved' | 'wont_fix' | null;
  ownerStatusAt: Date | null;
  ownerFlaggedAt: Date | null;
};

type MutationOpts = {
  onSuccess?: () => unknown;
  onError?: (e: { message: string; data: { code: string } }) => void;
};

const mocks = vi.hoisted(() => ({
  pages: [] as Array<{ items: unknown[]; nextCursor: number | undefined }>,
  listError: null as null | { message: string; data: { code: string } },
  listInputs: [] as Array<{ appListingId: string; ownerStatus?: string }>,
  nextPageParam: undefined as undefined | ((last: { nextCursor?: number }) => unknown),
  fetchNextCalls: 0,
  refetchCalls: 0,
  statusCalls: [] as unknown[],
  flagCalls: [] as unknown[],
  failWith: null as null | string,
  listInvalidations: [] as unknown[],
  countInvalidations: 0,
  /** Leave every mutation in flight: no callback fires and `isPending` stays true. */
  pending: false,
  /** What each `onSuccess` returned — React Query keeps the mutation pending on a promise. */
  successReturns: [] as unknown[],
}));

// Looked up per call: `beforeEach` replaces the arrays, so capturing one here would record
// into a stale array the assertions never read.
function mutation(record: 'statusCalls' | 'flagCalls') {
  return (opts: MutationOpts) => ({
    mutate: (input: unknown) => {
      mocks[record].push(input);
      if (mocks.pending) return;
      if (mocks.failWith)
        opts.onError?.({ message: 'server text', data: { code: mocks.failWith } });
      else mocks.successReturns.push(opts.onSuccess?.());
    },
    isPending: mocks.pending,
    variables: undefined,
  });
}

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy(
    {
      'appFeedback.listForListing': {
        useInfiniteQuery: (
          input: { appListingId: string; ownerStatus?: string },
          opts: { getNextPageParam: (last: { nextCursor?: number }) => unknown }
        ) => {
          const [loaded, setLoaded] = useState(1);
          mocks.listInputs.push(input);
          mocks.nextPageParam = opts.getNextPageParam;
          return {
            data: mocks.listError ? undefined : { pages: mocks.pages.slice(0, loaded) },
            isLoading: false,
            error: mocks.listError,
            hasNextPage: loaded < mocks.pages.length,
            isFetchingNextPage: false,
            fetchNextPage: () => {
              mocks.fetchNextCalls += 1;
              setLoaded((n) => n + 1);
            },
            refetch: () => {
              mocks.refetchCalls += 1;
            },
          };
        },
      },
      'appFeedback.setOwnerStatus': { useMutation: mutation('statusCalls') },
      'appFeedback.flagAbusive': { useMutation: mutation('flagCalls') },
    },
    {
      useUtils: () => ({
        appFeedback: {
          listForListing: {
            invalidate: async (input: unknown) => {
              mocks.listInvalidations.push(input);
            },
          },
          countNewForMyListings: {
            invalidate: async () => {
              mocks.countInvalidations += 1;
            },
          },
        },
      }),
    }
  ),
}));

const { AppFeedbackInboxPanel } = await import('./AppFeedbackInboxPanel');

/** Pairwise distinct on every rendered text field (message, reporter, meta, date, status). */
const NEWEST: Row = {
  id: 301,
  message: 'The upscale button does nothing on mobile',
  createdAt: new Date('2026-10-08T12:00:00Z'),
  reporter: { id: 11, username: 'mira_dev' },
  appBlockVersion: '1.4.0',
  appBlockSha: '3f9c2ab81d0e',
  surface: 'page',
  ownerStatus: null,
  ownerStatusAt: null,
  ownerFlaggedAt: null,
};
const OLDER: Row = {
  id: 288,
  message: 'Love the new presets',
  createdAt: new Date('2026-09-30T12:00:00Z'),
  reporter: { id: 12, username: null },
  appBlockVersion: '1.3.2',
  appBlockSha: null,
  surface: 'slot',
  ownerStatus: 'acknowledged',
  ownerStatusAt: new Date('2026-10-01T12:00:00Z'),
  ownerFlaggedAt: null,
};
const SECOND_PAGE: Row = {
  id: 150,
  message: 'Crashes when the model has no preview',
  createdAt: new Date('2026-09-02T12:00:00Z'),
  reporter: { id: 13, username: 'ollie' },
  appBlockVersion: null,
  appBlockSha: null,
  surface: null,
  ownerStatus: 'resolved',
  ownerStatusAt: new Date('2026-09-03T12:00:00Z'),
  ownerFlaggedAt: new Date('2026-09-03T13:00:00Z'),
};

beforeEach(() => {
  mocks.pages = [{ items: [NEWEST, OLDER], nextCursor: undefined }];
  mocks.listError = null;
  mocks.listInputs = [];
  mocks.nextPageParam = undefined;
  mocks.fetchNextCalls = 0;
  mocks.refetchCalls = 0;
  mocks.statusCalls = [];
  mocks.flagCalls = [];
  mocks.failWith = null;
  mocks.listInvalidations = [];
  mocks.countInvalidations = 0;
  mocks.pending = false;
  mocks.successReturns = [];
});

const filterOption = (label: string) =>
  page.getByTestId('app-feedback-filter').getByText(label, { exact: true });
const byId = (part: string, id: number) => page.getByTestId(`app-feedback-${part}-${id}`);

describe('the inbox lists what the server returned, newest first', () => {
  test('rows render in server order with reporter, message, version, surface and date', async () => {
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    await expect.element(byId('row', NEWEST.id)).toBeInTheDocument();
    const ids = page
      .getByTestId(/^app-feedback-row-/)
      .elements()
      .map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['app-feedback-row-301', 'app-feedback-row-288']);

    await expect.element(byId('message', NEWEST.id)).toHaveTextContent(NEWEST.message);
    await expect.element(byId('reporter', NEWEST.id)).toHaveTextContent('mira_dev');
    expect(byId('reporter', NEWEST.id).element().getAttribute('href')).toBe('/user/mira_dev');
    await expect
      .element(byId('meta', NEWEST.id))
      .toHaveTextContent('v1.4.0 (3f9c2ab) · App page · Oct 8, 2026');
    await expect.element(byId('meta', OLDER.id)).toHaveTextContent('v1.3.2 · Model page');
    await expect.element(byId('status', NEWEST.id)).toHaveTextContent('New');
    await expect.element(byId('status', OLDER.id)).toHaveTextContent('Acknowledged');
  });

  test('a deleted reporter is named as such and not linked', async () => {
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    await expect.element(byId('reporter', OLDER.id)).toHaveTextContent('Deleted account');
    expect(byId('reporter', OLDER.id).element().tagName).not.toBe('A');
  });

  test('queries THIS listing, unfiltered, keyed on the server cursor', async () => {
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    await expect.element(byId('row', NEWEST.id)).toBeInTheDocument();
    expect(mocks.listInputs.at(-1)).toEqual({ appListingId: 'apl_9', ownerStatus: undefined });
    expect(mocks.nextPageParam?.({ nextCursor: 288 })).toBe(288);
  });
});

describe('paging', () => {
  test('Load more appends the next page, then disappears', async () => {
    mocks.pages = [
      { items: [NEWEST, OLDER], nextCursor: OLDER.id },
      { items: [SECOND_PAGE], nextCursor: undefined },
    ];
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    await expect.element(byId('row', OLDER.id)).toBeInTheDocument();
    expect(byId('row', SECOND_PAGE.id).elements()).toHaveLength(0);

    await userEvent.click(page.getByTestId('app-feedback-load-more'));
    await expect.element(byId('row', SECOND_PAGE.id)).toBeInTheDocument();
    expect(mocks.fetchNextCalls).toBe(1);
    expect(page.getByTestId('app-feedback-load-more').elements()).toHaveLength(0);
  });
});

describe('filter', () => {
  test('a status filter is sent to the server; All sends none', async () => {
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    await userEvent.click(filterOption("Won't fix"));
    await expect.poll(() => mocks.listInputs.at(-1)?.ownerStatus).toBe('wont_fix');
    await userEvent.click(filterOption('New'));
    await expect.poll(() => mocks.listInputs.at(-1)?.ownerStatus).toBe('new');
    await userEvent.click(filterOption('All'));
    await expect.poll(() => mocks.listInputs.at(-1)?.ownerStatus).toBeUndefined();
  });
});

describe('owner status', () => {
  test('a NEW row offers all three statuses and sends `expectedOwnerStatus: null`', async () => {
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    await expect.element(byId('set-acknowledged', NEWEST.id)).toBeInTheDocument();
    await expect.element(byId('set-wont_fix', NEWEST.id)).toBeInTheDocument();
    await userEvent.click(byId('set-resolved', NEWEST.id));
    expect(mocks.statusCalls).toEqual([
      { id: 301, appListingId: 'apl_9', ownerStatus: 'resolved', expectedOwnerStatus: null },
    ]);
    expect(mocks.listInvalidations).toEqual([{ appListingId: 'apl_9' }]);
    expect(mocks.countInvalidations).toBe(1);
  });

  test('the write stays pending until the refreshed list lands (onSuccess returns the refetch)', async () => {
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    await userEvent.click(byId('set-resolved', NEWEST.id));
    expect(mocks.successReturns).toHaveLength(1);
    expect(mocks.successReturns[0]).toBeInstanceOf(Promise);
  });

  test('while a write is in flight every action on the row is disabled', async () => {
    mocks.pending = true;
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    for (const part of ['set-acknowledged', 'set-resolved', 'set-wont_fix', 'flag']) {
      await expect.element(byId(part, NEWEST.id)).toBeDisabled();
    }
  });

  test('a set row does not offer its own status and sends what the owner saw', async () => {
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    await expect.element(byId('set-resolved', OLDER.id)).toBeInTheDocument();
    expect(byId('set-acknowledged', OLDER.id).elements()).toHaveLength(0);
    await userEvent.click(byId('set-wont_fix', OLDER.id));
    expect(mocks.statusCalls).toEqual([
      {
        id: 288,
        appListingId: 'apl_9',
        ownerStatus: 'wont_fix',
        expectedOwnerStatus: 'acknowledged',
      },
    ]);
  });

  test('CONFLICT: "already changed — refresh", and Refresh refetches the list', async () => {
    mocks.failWith = 'CONFLICT';
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    await userEvent.click(byId('set-resolved', NEWEST.id));
    await expect.element(byId('error', NEWEST.id)).toHaveTextContent(INBOX_STALE_MESSAGE);
    expect(byId('error', OLDER.id).elements()).toHaveLength(0);
    expect(mocks.listInvalidations).toEqual([]);
    expect(mocks.countInvalidations).toBe(0);

    await userEvent.click(byId('refresh', NEWEST.id));
    expect(mocks.refetchCalls).toBe(1);
    expect(byId('error', NEWEST.id).elements()).toHaveLength(0);
  });

  test('FORBIDDEN reads as lost access, with no Refresh offered', async () => {
    mocks.failWith = 'FORBIDDEN';
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    await userEvent.click(byId('set-acknowledged', NEWEST.id));
    await expect.element(byId('error', NEWEST.id)).toHaveTextContent(INBOX_NO_ACCESS_MESSAGE);
    expect(byId('refresh', NEWEST.id).elements()).toHaveLength(0);
  });
});

describe('flag as abusive', () => {
  test('asks first; Cancel sends nothing; confirming flags THIS row', async () => {
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    await userEvent.click(byId('flag', NEWEST.id));
    await expect.element(byId('flag-confirm', NEWEST.id)).toBeInTheDocument();
    expect(mocks.flagCalls).toEqual([]);

    await userEvent.click(byId('flag-confirm-no', NEWEST.id));
    expect(byId('flag-confirm', NEWEST.id).elements()).toHaveLength(0);
    expect(mocks.flagCalls).toEqual([]);

    await userEvent.click(byId('flag', NEWEST.id));
    await userEvent.click(byId('flag-confirm-yes', NEWEST.id));
    expect(mocks.flagCalls).toEqual([{ id: 301, appListingId: 'apl_9' }]);
    expect(mocks.listInvalidations).toEqual([{ appListingId: 'apl_9' }]);
  });

  test('an already-flagged row shows the flag and offers no second one', async () => {
    mocks.pages = [{ items: [SECOND_PAGE], nextCursor: undefined }];
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    await expect.element(byId('flagged', SECOND_PAGE.id)).toBeInTheDocument();
    expect(byId('flag', SECOND_PAGE.id).elements()).toHaveLength(0);
  });

  test('a CONFLICT on flag (already flagged elsewhere) offers Refresh', async () => {
    mocks.failWith = 'CONFLICT';
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    await userEvent.click(byId('flag', NEWEST.id));
    await userEvent.click(byId('flag-confirm-yes', NEWEST.id));
    await expect.element(byId('error', NEWEST.id)).toHaveTextContent(INBOX_STALE_MESSAGE);
    await expect.element(byId('refresh', NEWEST.id)).toBeInTheDocument();
  });
});

describe('empty and error states', () => {
  test('the privacy note is always shown above the list', async () => {
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    await expect
      .element(page.getByTestId('app-feedback-privacy'))
      .toHaveTextContent(
        "Private feedback from people using this app. Only you, your collaborators and Civitai moderators can read it — it never appears on the app's page."
      );
  });

  test('on-site, nothing yet: the inbox explanation only', async () => {
    mocks.pages = [{ items: [], nextCursor: undefined }];
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    await expect
      .element(page.getByTestId('app-feedback-empty'))
      .toHaveTextContent(INBOX_EMPTY_MESSAGE);
    expect(page.getByText(INBOX_EMPTY_OFFSITE_NOTE).elements()).toHaveLength(0);
  });

  test('off-site, nothing yet: also says why', async () => {
    mocks.pages = [{ items: [], nextCursor: undefined }];
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="offsite" />);
    await expect.element(page.getByText(INBOX_EMPTY_OFFSITE_NOTE)).toBeInTheDocument();
  });

  test('a filter with no matches says so instead of "no feedback yet"', async () => {
    mocks.pages = [{ items: [], nextCursor: undefined }];
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    await userEvent.click(filterOption('Resolved'));
    await expect
      .element(page.getByTestId('app-feedback-empty'))
      .toHaveTextContent(INBOX_FILTER_EMPTY_MESSAGE);
    expect(page.getByTestId('app-feedback-empty').element().textContent).not.toContain(
      INBOX_EMPTY_MESSAGE
    );
  });

  test('a failed read is an error, never the empty state', async () => {
    mocks.listError = { message: 'nope', data: { code: 'FORBIDDEN' } };
    renderWithProviders(<AppFeedbackInboxPanel appListingId="apl_9" kind="onsite" />);
    await expect
      .element(page.getByTestId('app-feedback-load-error'))
      .toHaveTextContent(INBOX_NO_ACCESS_MESSAGE);
    expect(page.getByTestId('app-feedback-empty').elements()).toHaveLength(0);
  });
});
