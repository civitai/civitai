import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MantineNotifications from '@mantine/notifications';

/**
 * The takedown warning toast → moderation history WIRING. `appListingModerationView.test.ts` pins
 * what the notice says and which listing it names; this pins the seam between the toast and the
 * history modal: the toast's button opens the history of THAT listing, through the shared opener,
 * and the opener puts the shared modal in the global dialog store keyed by that listing.
 *
 * Node tier, no DOM: the toast body is a function component with no hooks, so it is called
 * directly and its button's `onClick` is invoked. Only Mantine's `showNotification` is stubbed;
 * the dialog store is the real one, read back through `useDialogStore.getState()`.
 */

const { notify } = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock('@mantine/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof MantineNotifications>()),
  showNotification: notify,
}));

import { useDialogStore } from '~/components/Dialog/dialogStore';
import {
  ListingModerationHistoryModal,
  listingModerationHistoryDialogId,
  openListingModerationHistory,
} from '~/components/Apps/ListingModerationHistoryModal';
import {
  OfflineCutNoticeMessage,
  showOfflineCutFailureWarning,
} from '~/components/Apps/offlineCutNotice';

type El = ReactElement<Record<string, unknown>>;

/** Depth-first search of a rendered element tree for the element with this test id. */
function findByTestId(node: unknown, testId: string): El | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findByTestId(n, testId);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as El;
  if (el.props?.['data-testid'] === testId) return el;
  return findByTestId(el.props?.children, testId);
}

/** The toast body the last warning was shown with, rendered one level. */
function shownMessage(): El {
  expect(notify).toHaveBeenCalledTimes(1);
  const message = (notify.mock.calls[0][0] as { message: El }).message;
  expect(message.type).toBe(OfflineCutNoticeMessage);
  return (message.type as (p: unknown) => El)(message.props);
}

const FAILED = {
  appListingId: 'apl_cut_failed_3',
  status: 'removed',
  offlineCut: { outcome: 'failed' },
};
const LISTING = { appListingId: 'apl_cut_failed_3', slug: 'cut-failed-app' };

type OpenedDialog = {
  id: unknown;
  component: unknown;
  props: { listing: unknown; onClose: () => void };
};
const openDialogs = () => useDialogStore.getState().dialogs as unknown as OpenedDialog[];

beforeEach(() => {
  vi.clearAllMocks();
  useDialogStore.getState().closeAll();
});

describe('takedown warning toast → moderation history', () => {
  it('🔴 the toast’s button opens the TAKEN-DOWN listing’s history', () => {
    showOfflineCutFailureWarning(FAILED, LISTING);
    expect(notify.mock.calls[0][0]).toMatchObject({
      title: 'Offline access not cut',
      autoClose: false,
    });
    const button = findByTestId(shownMessage(), 'apps-offline-cut-open-history');
    expect(button).not.toBeNull();
    expect(openDialogs()).toEqual([]);
    (button!.props.onClick as () => void)();
    expect(openDialogs()).toHaveLength(1);
    const [dialog] = openDialogs();
    expect(dialog.id).toBe('listing-moderation-history-apl_cut_failed_3');
    expect(dialog.component).toBe(ListingModerationHistoryModal);
    expect(dialog.props.listing).toEqual({
      appListingId: 'apl_cut_failed_3',
      slug: 'cut-failed-app',
    });
  });

  it('🔴 when the result names a DIFFERENT listing than the caller, the button opens the result’s', () => {
    showOfflineCutFailureWarning({ ...FAILED, appListingId: 'apl_server_side_7' }, LISTING);
    const button = findByTestId(shownMessage(), 'apps-offline-cut-open-history');
    (button!.props.onClick as () => void)();
    expect(openDialogs()[0].props.listing).toEqual({
      appListingId: 'apl_server_side_7',
      slug: '',
    });
  });

  it('no toast (and so no way to open anything) on a successful cut or with the flag off', () => {
    showOfflineCutFailureWarning(
      {
        appListingId: 'apl_cut_failed_3',
        status: 'removed',
        offlineCut: { outcome: 'cut', deleted: 4 },
      },
      LISTING
    );
    showOfflineCutFailureWarning({ appListingId: 'apl_cut_failed_3', status: 'removed' }, LISTING);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('openListingModerationHistory — the one opener every surface uses', () => {
  it('puts the shared modal in the dialog store keyed by listing, and its close removes that one', () => {
    openListingModerationHistory({ appListingId: 'apl_open_5', slug: 'open-app' });
    openListingModerationHistory({ appListingId: 'apl_other_6', slug: 'other-app' });
    expect(openDialogs()).toHaveLength(2);
    const [dialog] = openDialogs();
    expect(dialog.id).toBe(listingModerationHistoryDialogId('apl_open_5'));
    expect(dialog.id).toBe('listing-moderation-history-apl_open_5');
    expect(dialog.component).toBe(ListingModerationHistoryModal);
    expect(dialog.props.listing).toEqual({ appListingId: 'apl_open_5', slug: 'open-app' });
    dialog.props.onClose();
    expect(openDialogs().map((d) => d.id)).toEqual(['listing-moderation-history-apl_other_6']);
  });
});
