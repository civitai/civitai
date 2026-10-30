import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { StorylineCollaboratorsPanel } from '~/components/Storyline/manage/StorylineCollaboratorsPanel';
import {
  StorylineInviteAlert,
  StorylineLeaveCollaboration,
} from '~/components/Storyline/StorylineInviteAlert';
import { STORYLINE_MAX_COLLABORATORS } from '~/shared/utils/storyline';
import type * as TrpcMod from '~/utils/trpc';

const mocks = vi.hoisted(() => ({ accept: vi.fn(), decline: vi.fn() }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy({
    'storyline.acceptInvite': { useMutation: () => ({ isPending: false, mutate: mocks.accept }) },
    'storyline.leave': { useMutation: () => ({ isPending: false, mutate: mocks.decline }) },
  }),
}));
vi.mock('~/components/Search/QuickSearchDropdown', () => ({
  QuickSearchDropdown: () => <input />,
}));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ userId, subText }: { userId: number; subText?: React.ReactNode }) => (
    <div data-testid={`user-${userId}`}>{subText}</div>
  ),
}));

beforeEach(() => {
  mocks.accept.mockReset();
  mocks.decline.mockReset();
});

describe("the invitee's answer", () => {
  test('Accept and Decline answer the invitation for this storyline', async () => {
    renderWithProviders(<StorylineInviteAlert storylineId={4} ownerUsername="owner" />);
    await expect.element(page.getByText('owner invited you to collaborate')).toBeVisible();

    await page.getByRole('button', { name: 'Accept' }).click();
    expect(mocks.accept).toHaveBeenCalledWith({ storylineId: 4 });
    expect(mocks.decline).not.toHaveBeenCalled();
    // Declining is leaving, which stays open to a muted account.
    await page.getByRole('button', { name: 'Decline' }).click();
    expect(mocks.decline).toHaveBeenCalledWith({ storylineId: 4 });
    expect(mocks.accept).toHaveBeenCalledTimes(1);
  });
});

// Confirms at once.
vi.mock('@mantine/modals', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openConfirmModal: ({ onConfirm }: { onConfirm: () => void }) => onConfirm(),
}));

describe('a collaborator leaving', () => {
  test('leaves this storyline after confirming', async () => {
    renderWithProviders(<StorylineLeaveCollaboration storylineId={4} />);
    await page.getByRole('button', { name: 'Leave' }).click();
    expect(mocks.decline).toHaveBeenCalledWith({ storylineId: 4 });
  });
});

describe("the owner's collaborator list", () => {
  const panel = (pending: { id: number; username: string }[], onRemove = vi.fn()) => {
    renderWithProviders(
      <StorylineCollaboratorsPanel
        ownerId={1}
        collaborators={[{ id: 2, username: 'joined' }]}
        pending={pending}
        canEndorse
        onAdd={vi.fn()}
        onRemove={onRemove}
      />
    );
    return onRemove;
  };

  test('shows an invitation as waiting, and lets the owner cancel it', async () => {
    const onRemove = panel([{ id: 3, username: 'invitee' }]);
    await expect.element(page.getByTestId('user-3')).toHaveTextContent('Invited');
    await expect.element(page.getByTestId('user-2')).toHaveTextContent('Endorsed');

    await page.getByRole('button', { name: 'Cancel invitee invitation' }).click();
    expect(onRemove).toHaveBeenCalledWith(3);
  });

  test('counts invitations toward the limit', async () => {
    panel(
      Array.from({ length: STORYLINE_MAX_COLLABORATORS - 1 }, (_, i) => ({
        id: 10 + i,
        username: `u${i}`,
      }))
    );
    await expect.element(page.getByText(/invitations included/)).toBeVisible();
  });
});
