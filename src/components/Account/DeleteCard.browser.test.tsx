import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

const { mutateAsync, logout } = vi.hoisted(() => ({
  mutateAsync: vi.fn(async () => undefined),
  logout: vi.fn(async () => undefined),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));
vi.mock('~/components/CivitaiWrapped/AccountProvider', () => ({
  useAccountContext: () => ({ logout }),
}));
vi.mock('~/utils/notifications', () => ({ showErrorNotification: vi.fn() }));
vi.mock('~/utils/trpc', () => ({
  trpc: {
    subscriptions: {
      getAllUserSubscriptions: { useQuery: () => ({ data: [], isLoading: false }) },
    },
    user: { delete: { useMutation: () => ({ mutateAsync }) } },
  },
}));

import { DeleteCard } from '~/components/Account/DeleteCard';

/** Walks the flow up to the images question, which is the last step before the mutation fires. */
async function openImagesModal() {
  await userEvent.click(page.getByRole('button', { name: 'Delete your account' }));
  await userEvent.fill(page.getByPlaceholder('Type DELETE to confirm'), 'DELETE');
  await userEvent.click(page.getByRole('button', { name: 'Yes, I am sure' }));
  await userEvent.click(page.getByRole('button', { name: 'No' }));
  await expect.element(page.getByRole('button', { name: 'Delete now' })).toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DeleteCard images question', () => {
  test('dismissing it resets the flow instead of stranding the typed confirmation', async () => {
    renderWithProviders(<DeleteCard />);
    await openImagesModal();

    await userEvent.keyboard('{Escape}');
    await userEvent.click(page.getByRole('button', { name: 'Delete your account' }));

    // A bare `setImagesModalOpen(false)` leaves DELETE in the box, so the next visit to the
    // settings page is one click away from deleting the account.
    await expect.element(page.getByPlaceholder('Type DELETE to confirm')).toHaveValue('');
    await expect.element(page.getByRole('button', { name: 'Yes, I am sure' })).toBeDisabled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  test('gives the reversible choice the emphasis, not the irreversible one', async () => {
    renderWithProviders(<DeleteCard />);
    await openImagesModal();

    // Delete now is the branch a moderator cannot undo, so it must not be the filled default.
    const deleteNow = page.getByRole('button', { name: 'Delete now' }).element();
    const afterSevenDays = page.getByRole('button', { name: 'Delete after 7 days' }).element();
    expect(deleteNow.getAttribute('data-variant')).toBe('outline');
    expect(afterSevenDays.getAttribute('data-variant')).not.toBe('outline');
  });

  test('still records each branch choice', async () => {
    renderWithProviders(<DeleteCard />);
    await openImagesModal();

    await userEvent.click(page.getByRole('button', { name: 'Delete after 7 days' }));

    expect(mutateAsync).toHaveBeenCalledWith({ id: 7, removeModels: false, removeImages: false });
  });
});
