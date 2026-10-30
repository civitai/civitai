import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { StorylineCollaboratorsPanel } from '~/components/Storyline/manage/StorylineCollaboratorsPanel';
import { StorylineInviteAlert } from '~/components/Storyline/StorylineInviteAlert';
import { STORYLINE_MAX_COLLABORATORS } from '~/shared/utils/storyline';
import type * as TrpcMod from '~/utils/trpc';

const mocks = vi.hoisted(() => ({ respond: vi.fn() }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: (await import('../../../../test/trpcProxyStub')).makeTrpcProxy({
    'storyline.respondToInvite': {
      useMutation: () => ({ isPending: false, variables: undefined, mutate: mocks.respond }),
    },
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

beforeEach(() => mocks.respond.mockReset());

describe("the invitee's answer", () => {
  test('Accept and Decline answer the invitation for this storyline', async () => {
    renderWithProviders(<StorylineInviteAlert storylineId={4} ownerUsername="owner" />);
    await expect.element(page.getByText('owner invited you to collaborate')).toBeVisible();

    await page.getByRole('button', { name: 'Accept' }).click();
    expect(mocks.respond).toHaveBeenLastCalledWith({ storylineId: 4, accept: true });
    await page.getByRole('button', { name: 'Decline' }).click();
    expect(mocks.respond).toHaveBeenLastCalledWith({ storylineId: 4, accept: false });
    expect(mocks.respond).toHaveBeenCalledTimes(2);
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
