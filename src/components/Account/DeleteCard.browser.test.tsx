import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
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
// Only the `trpc` client is overridden; the module's other exports are kept via importOriginal
// so a consumer elsewhere in the tree doesn't get `undefined` and silently collect zero tests.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    subscriptions: {
      getAllUserSubscriptions: { useQuery: () => ({ data: [], isLoading: false }) },
    },
    user: { delete: { useMutation: () => ({ mutateAsync }) } },
  },
}));

import { DeleteCard } from '~/components/Account/DeleteCard';

/** Renders the card and opens the "what happens to your content?" step. */
async function openContentModal() {
  renderWithProviders(<DeleteCard />);
  await userEvent.click(page.getByRole('button', { name: 'Delete your account' }));
  await expect.element(page.getByRole('radio', { name: 'Delete them' })).toBeInTheDocument();
}

/** Walks the full flow end to end, choosing the given radio options on the content step. */
async function completeFlow(modelsLabel: string, imagesLabel: string) {
  await openContentModal();
  await userEvent.click(page.getByLabelText(modelsLabel));
  await userEvent.click(page.getByLabelText(imagesLabel));
  await userEvent.click(page.getByRole('button', { name: 'Continue' }));
  await userEvent.fill(page.getByPlaceholder('Type DELETE to confirm'), 'DELETE');
  await userEvent.click(page.getByRole('button', { name: 'Delete my account' }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DeleteCard content step', () => {
  test('neither radio group has a default, so Continue starts disabled', async () => {
    await openContentModal();

    await expect.element(page.getByRole('radio', { name: 'Delete them' })).not.toBeChecked();
    await expect.element(page.getByRole('radio', { name: 'Delete now' })).not.toBeChecked();
    await expect.element(page.getByRole('button', { name: 'Continue' })).toBeDisabled();

    await userEvent.click(page.getByLabelText('Delete them'));
    await expect.element(page.getByRole('button', { name: 'Continue' })).toBeDisabled();

    await userEvent.click(page.getByLabelText('Delete now'));
    await expect.element(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  test('cancelling resets both radio selections and the typed confirmation', async () => {
    await openContentModal();
    await userEvent.click(page.getByLabelText('Delete them'));
    await userEvent.click(page.getByLabelText('Delete now'));
    await userEvent.click(page.getByRole('button', { name: 'Continue' }));
    await userEvent.fill(page.getByPlaceholder('Type DELETE to confirm'), 'DELETE');

    // Dismissing the confirm step (rather than cancelling from it) must still count
    // as cancelling the whole flow, or the typed DELETE strands in the box.
    await userEvent.keyboard('{Escape}');
    await userEvent.click(page.getByRole('button', { name: 'Delete your account' }));

    await expect.element(page.getByRole('radio', { name: 'Delete them' })).not.toBeChecked();
    await expect.element(page.getByRole('radio', { name: 'Delete now' })).not.toBeChecked();

    await userEvent.click(page.getByLabelText('Keep them public'));
    await userEvent.click(page.getByLabelText('Delete after 7 days'));
    await userEvent.click(page.getByRole('button', { name: 'Continue' }));

    await expect.element(page.getByPlaceholder('Type DELETE to confirm')).toHaveValue('');
    await expect.element(page.getByRole('button', { name: 'Delete my account' })).toBeDisabled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

describe('DeleteCard confirm step summary', () => {
  test('restates deletion choices as deletion', async () => {
    await openContentModal();
    await userEvent.click(page.getByLabelText('Delete them'));
    await userEvent.click(page.getByLabelText('Delete now'));
    await userEvent.click(page.getByRole('button', { name: 'Continue' }));

    await expect.element(page.getByText('Your models will be deleted')).toBeInTheDocument();
    await expect.element(page.getByText('Your images will be deleted now')).toBeInTheDocument();
  });

  test('restates keep-it choices without deletion phrasing', async () => {
    await openContentModal();
    await userEvent.click(page.getByLabelText('Keep them public'));
    await userEvent.click(page.getByLabelText('Delete after 7 days'));
    await userEvent.click(page.getByRole('button', { name: 'Continue' }));

    await expect
      .element(page.getByText('Your models will stay public under an anonymous owner'))
      .toBeInTheDocument();
    await expect
      .element(page.getByText('Your images will be hidden now and deleted after 7 days'))
      .toBeInTheDocument();
  });
});

describe('DeleteCard mutation polarity', () => {
  test('Delete them + Delete now -> removeModels: true, removeImages: true', async () => {
    await completeFlow('Delete them', 'Delete now');
    expect(mutateAsync).toHaveBeenCalledWith({ id: 7, removeModels: true, removeImages: true });
  });

  test('Delete them + Delete after 7 days -> removeModels: true, removeImages: false', async () => {
    await completeFlow('Delete them', 'Delete after 7 days');
    expect(mutateAsync).toHaveBeenCalledWith({ id: 7, removeModels: true, removeImages: false });
  });

  test('Keep them public + Delete now -> removeModels: false, removeImages: true', async () => {
    await completeFlow('Keep them public', 'Delete now');
    expect(mutateAsync).toHaveBeenCalledWith({ id: 7, removeModels: false, removeImages: true });
  });

  test('Keep them public + Delete after 7 days -> removeModels: false, removeImages: false', async () => {
    await completeFlow('Keep them public', 'Delete after 7 days');
    expect(mutateAsync).toHaveBeenCalledWith({ id: 7, removeModels: false, removeImages: false });
  });
});
