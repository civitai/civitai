import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

// This toggle mounts inside clickable challenge cards, a dropdown menu, and the detail
// page (Task 10). If a future refactor drops `stopPropagation()`, a bell click bubbles
// into the card's own click/navigation handler and the whole card navigates away instead
// of just toggling notify state — a high-visibility regression with no other coverage.

const mocks = vi.hoisted(() => ({
  currentUser: { current: null as { id: number } | null },
  trackedIds: { current: new Set<number>() },
  toggleNotify: vi.fn(),
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.currentUser.current,
}));

vi.mock('~/components/Challenge/challenge.utils', () => ({
  useTrackedChallengeIds: () => ({ trackedIds: mocks.trackedIds.current, isLoading: false }),
  useToggleChallengeNotify: () => ({ toggleNotify: mocks.toggleNotify, toggling: false }),
}));

import { ChallengeNotifyToggle } from '~/components/Challenge/ChallengeNotifyToggle';
import { ChallengeStatus } from '~/shared/utils/prisma/enums';

describe('ChallengeNotifyToggle', () => {
  beforeEach(() => {
    mocks.currentUser.current = { id: 1 };
    mocks.trackedIds.current = new Set();
    mocks.toggleNotify.mockReset();
  });

  test('renders nothing when logged out', async () => {
    mocks.currentUser.current = null;
    await renderWithProviders(
      <ChallengeNotifyToggle challenge={{ id: 1, status: ChallengeStatus.Scheduled }} />
    );
    expect(page.getByRole('button').query()).toBeNull();
  });

  test('renders nothing for a non-trackable status', async () => {
    await renderWithProviders(
      <ChallengeNotifyToggle challenge={{ id: 1, status: ChallengeStatus.Completed }} />
    );
    expect(page.getByRole('button').query()).toBeNull();
  });

  test('renders when Scheduled', async () => {
    await renderWithProviders(
      <ChallengeNotifyToggle challenge={{ id: 1, status: ChallengeStatus.Scheduled }} />
    );
    await expect.element(page.getByRole('button')).toBeInTheDocument();
  });

  test('renders when Active', async () => {
    await renderWithProviders(
      <ChallengeNotifyToggle challenge={{ id: 1, status: ChallengeStatus.Active }} />
    );
    await expect.element(page.getByRole('button')).toBeInTheDocument();
  });

  test('shows the un-tracked affordance when the challenge id is not in the tracked set', async () => {
    mocks.trackedIds.current = new Set([999]);
    await renderWithProviders(
      <ChallengeNotifyToggle challenge={{ id: 5, status: ChallengeStatus.Scheduled }} />
    );
    await expect
      .element(page.getByRole('button', { name: 'Notify me when this starts' }))
      .toBeInTheDocument();
  });

  test('shows the tracked affordance when the challenge id is in the tracked set', async () => {
    mocks.trackedIds.current = new Set([5]);
    await renderWithProviders(
      <ChallengeNotifyToggle challenge={{ id: 5, status: ChallengeStatus.Scheduled }} />
    );
    await expect
      .element(page.getByRole('button', { name: 'Stop notifying me' }))
      .toBeInTheDocument();
  });

  test('a click never reaches the wrapping card link', async () => {
    const outerClick = vi.fn();
    await renderWithProviders(
      // eslint-disable-next-line jsx-a11y/anchor-is-valid
      <a href="#" onClick={outerClick}>
        <ChallengeNotifyToggle challenge={{ id: 5, status: ChallengeStatus.Scheduled }} />
      </a>
    );
    await page.getByRole('button').click();
    expect(outerClick).not.toHaveBeenCalled();
  });

  test('clicking an untracked challenge calls toggleNotify with setTo: true', async () => {
    mocks.trackedIds.current = new Set();
    await renderWithProviders(
      <ChallengeNotifyToggle challenge={{ id: 5, status: ChallengeStatus.Scheduled }} />
    );
    await page.getByRole('button').click();
    expect(mocks.toggleNotify).toHaveBeenCalledWith(5, true);
  });

  test('clicking a tracked challenge calls toggleNotify with setTo: false', async () => {
    mocks.trackedIds.current = new Set([5]);
    await renderWithProviders(
      <ChallengeNotifyToggle challenge={{ id: 5, status: ChallengeStatus.Scheduled }} />
    );
    await page.getByRole('button').click();
    expect(mocks.toggleNotify).toHaveBeenCalledWith(5, false);
  });
});
