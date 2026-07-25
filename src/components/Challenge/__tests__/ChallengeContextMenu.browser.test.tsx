import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

// The menu used to early-return `null` for anyone but the owner, so adding the
// notify item required loosening that guard to `!canDelete && !canTrack`. If a
// future edit drops the `{canDelete && ...}` gate around the Delete item while
// keeping the loosened guard, every non-owner would see (and could attempt) a
// Delete option the server would reject — a UI regression with no other coverage.

const mocks = vi.hoisted(() => ({
  currentUser: { current: null as { id: number } | null },
  trackedIds: { current: new Set<number>() },
  toggleNotify: vi.fn(),
  deleteChallenge: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.currentUser.current,
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ userChallenges: true }),
}));

vi.mock('~/components/Challenge/challenge.utils', () => ({
  useTrackedChallengeIds: () => ({ trackedIds: mocks.trackedIds.current, isLoading: false }),
  useToggleChallengeNotify: () => ({ toggleNotify: mocks.toggleNotify, toggling: false }),
  useDeleteUserChallenge: () => ({ deleteChallenge: mocks.deleteChallenge, deleting: false }),
}));

import { ChallengeContextMenu } from '~/components/Challenge/ChallengeContextMenu';
import { ChallengeSource, ChallengeStatus } from '~/shared/utils/prisma/enums';

describe('ChallengeContextMenu', () => {
  beforeEach(() => {
    mocks.currentUser.current = { id: 1 };
    mocks.trackedIds.current = new Set();
    mocks.toggleNotify.mockReset();
    mocks.deleteChallenge.mockReset();
  });

  test('a non-owner viewing a trackable challenge sees Notify me but not Delete', async () => {
    mocks.currentUser.current = { id: 2 };
    await renderWithProviders(
      <ChallengeContextMenu
        challenge={{
          id: 10,
          createdById: 1,
          source: ChallengeSource.User,
          status: ChallengeStatus.Scheduled,
        }}
      />
    );
    await page.getByRole('button', { name: 'More options' }).click();
    await expect.element(page.getByRole('menuitem', { name: 'Notify me' })).toBeInTheDocument();
    expect(page.getByRole('menuitem', { name: 'Delete' }).query()).toBeNull();
  });

  // Tracking requires an account, so for a logged-out visitor the dropdown would render empty —
  // a dots button that opens nothing on every Scheduled/Active card.
  test('a logged-out visitor gets no menu at all', async () => {
    mocks.currentUser.current = null;
    await renderWithProviders(
      <ChallengeContextMenu
        challenge={{
          id: 10,
          createdById: 1,
          source: ChallengeSource.User,
          status: ChallengeStatus.Scheduled,
        }}
      />
    );
    expect(page.getByRole('button', { name: 'More options' }).query()).toBeNull();
  });

  test('the owner still sees Delete', async () => {
    mocks.currentUser.current = { id: 1 };
    await renderWithProviders(
      <ChallengeContextMenu
        challenge={{
          id: 10,
          createdById: 1,
          source: ChallengeSource.User,
          status: ChallengeStatus.Scheduled,
        }}
      />
    );
    await page.getByRole('button', { name: 'More options' }).click();
    await expect.element(page.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });
});
