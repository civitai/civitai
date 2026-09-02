import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as CreatorUtils from '~/components/Announcements/creator-announcements.utils';
import type * as CurrentUser from '~/hooks/useCurrentUser';

/**
 * Who gets offered the delete control, in both chromes.
 *
 * The server is the real gate — `deleteCreatorAnnouncement` is a `guardedProcedure` and
 * `assertOwnedAnnouncement` scopes by owner — so this is about the affordance, not about
 * authorization. It is here because the two chromes were separate components until they were
 * collapsed behind `as`, and a destructive control's gate should not be rewritten with
 * nothing on either side of it: mutating `canDelete` to `!!currentUser` reddened nothing in
 * the repo before this file existed.
 */

const mocks = vi.hoisted(() => ({
  currentUser: null as { id: number; isModerator: boolean } | null,
}));

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => mocks.currentUser,
}));

vi.mock('~/components/Announcements/creator-announcements.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorUtils>()),
  useDeleteCreatorAnnouncement: () => ({ deleteAnnouncement: vi.fn(), isLoading: false }),
}));

const AUTHOR = 99;
const announcement = { id: 1, userId: AUTHOR } as any;

async function renderDelete() {
  const { DeleteCreatorAnnouncementButton } = await import(
    '~/components/Announcements/CreatorAnnouncementsCarousel'
  );
  // The marker is load-bearing. A negative read straight after render sees an empty body —
  // the commit is asynchronous — so `elements()` would return 0 for every case, including
  // the ones where the control SHOULD be there. Awaiting a sibling that always renders
  // proves the tree is committed before the absence is read. Measured: without it, widening
  // the gate to `!!currentUser` left all four tests green.
  renderWithProviders(
    <>
      <span>delete gate rendered</span>
      <DeleteCreatorAnnouncementButton announcement={announcement} />
    </>
  );
  await expect.element(page.getByText('delete gate rendered')).toBeInTheDocument();
}

function deleteControls() {
  return page.getByRole('button', { name: 'Delete announcement' }).elements();
}

describe('who is offered the delete control', () => {
  beforeEach(() => {
    mocks.currentUser = null;
  });

  test('the author sees it', async () => {
    mocks.currentUser = { id: AUTHOR, isModerator: false };
    await renderDelete();

    await expect
      .element(page.getByRole('button', { name: 'Delete announcement' }))
      .toBeInTheDocument();
  });

  test('a moderator sees it on someone else’s announcement', async () => {
    mocks.currentUser = { id: AUTHOR + 1, isModerator: true };
    await renderDelete();

    await expect
      .element(page.getByRole('button', { name: 'Delete announcement' }))
      .toBeInTheDocument();
  });

  // The two negatives are what the mutation `canDelete = !!currentUser` breaks, and they are
  // paired with the positives above so "absent" means the gate refused rather than that the
  // component rendered nothing at all.
  test('another signed-in user does not', async () => {
    mocks.currentUser = { id: AUTHOR + 1, isModerator: false };
    await renderDelete();

    expect(deleteControls()).toHaveLength(0);
  });

  test('a signed-out visitor does not', async () => {
    mocks.currentUser = null;
    await renderDelete();

    expect(deleteControls()).toHaveLength(0);
  });
});
