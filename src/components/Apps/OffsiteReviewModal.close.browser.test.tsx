import { Button } from '@mantine/core';
import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as UserAvatarMod from '~/components/UserAvatar/UserAvatar';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';

/**
 * REPRODUCTION, in a FOREGROUND browser, of a reported defect: the LISTING-MEDIA review modal
 * (opened READ-ONLY with "View" from the Approved tab) "cannot be closed" — the × and Escape
 * reportedly did nothing.
 *
 * The report came from a screenshot tour driving a BACKGROUND tab, the same tour that also
 * recorded tab clicks failing until the tab was woken — so the report alone does not separate
 * a real defect from a harness that dispatched events into a throttled page. This file drives
 * the exact shape the tour opened (an on-site listing-media revision, `readOnly`, with a live
 * parent) in a foreground page and asserts both affordances close it.
 *
 * The sibling `OffsiteReviewModal.focus.browser.test.tsx` already closes a PENDING external
 * row; these are the two dimensions it does not cover (`kind: 'onsite'` and `readOnly`), plus
 * the close button's accessible name.
 */

const hoisted = vi.hoisted(() => ({
  row: {
    id: 'req-media-1',
    kind: 'onsite' as const,
    appListingId: 'listing-shadow-1',
    slug: 'ci-media-app',
    status: 'approved',
    submittedAt: new Date('2026-01-01T00:00:00Z'),
    changelog: 'new store imagery',
    appListing: {
      name: 'CI Media App',
      externalUrl: null,
      category: 'generation',
      contentRating: 'pg13',
      revisionOfId: 'listing-parent-1',
    },
    submittedBy: { id: 42, username: 'author-dev', deletedAt: null, image: null },
  },
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ appBlocks: true }),
}));
vi.mock('~/components/UserAvatar/UserAvatar', async (importOriginal) => ({
  ...(await importOriginal<typeof UserAvatarMod>()),
  UserAvatar: (props: { user?: { username?: string | null } }) => (
    <a href={`/user/${props.user?.username}`}>{props.user?.username}</a>
  ),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  return {
    ...actual,
    trpc: makeTrpcProxy({
      'appListings.getAssets': {
        useQuery: () => ({ data: null, isLoading: false, error: null }),
      },
      'appListings.getListingPreviewForReview': {
        useQuery: () => ({ data: undefined, isLoading: false, error: null }),
      },
    }),
  };
});

const { OffsiteReviewModal } = await import('./OffsiteReviewQueue');

beforeEach(async () => {
  await page.viewport(1124, 1305);
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button data-testid="opener" onClick={() => setOpen(true)}>
        View
      </Button>
      <OffsiteReviewModal
        request={open ? (hoisted.row as never) : null}
        onClose={() => setOpen(false)}
        readOnly
      />
    </>
  );
}

const dialog = () => document.querySelector('[role="dialog"][aria-modal="true"]');

async function openModal() {
  await renderWithProviders(<Harness />);
  await userEvent.click(document.querySelector('[data-testid="opener"]') as HTMLElement);
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
}

describe('listing-media review modal (read-only) — it CLOSES', () => {
  test('the × closes it', async () => {
    await openModal();
    const close = page.getByRole('button', { name: 'Close review' });
    await expect.element(close).toBeInTheDocument();
    await close.click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });

  test('Escape closes it', async () => {
    await openModal();
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });
});
