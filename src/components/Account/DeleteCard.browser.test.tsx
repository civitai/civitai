import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

const { mutateAsync, logout, currentUser } = vi.hoisted(() => ({
  mutateAsync: vi.fn(async () => undefined),
  logout: vi.fn(async () => undefined),
  currentUser: { value: { id: 7, muted: false } },
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => currentUser.value }));
vi.mock('~/components/CivitaiWrapped/AccountProvider', () => ({
  useAccountContext: () => ({ logout }),
}));
vi.mock('~/utils/notifications', () => ({ showErrorNotification: vi.fn() }));
// Only the `trpc` client is overridden; the module's other exports are kept via importOriginal
// so a consumer elsewhere in the tree doesn't get `undefined` and silently collect zero tests.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'subscriptions.getAllUserSubscriptions': { useQuery: () => ({ data: [], isLoading: false }) },
    'user.delete': { useMutation: () => ({ mutateAsync }) },
  }),
}));

import { DeleteCard } from '~/components/Account/DeleteCard';
import { SUPPORT_LINKS } from '~/components/Support/support.constants';

/** Renders the card and opens the "what happens to your content?" step. */
async function openContentModal() {
  renderWithProviders(<DeleteCard />);
  await userEvent.click(page.getByRole('button', { name: 'Delete your account' }));
  await expect.element(page.getByRole('radio', { name: 'Delete them' })).toBeInTheDocument();
}

/**
 * Clicks a choice and confirms it took. Continue stays disabled while either radio group is empty,
 * so without this a click that did not register shows up only as a timeout on Continue, naming
 * neither click.
 */
async function choose(label: string) {
  await userEvent.click(page.getByLabelText(label));
  await expect.element(page.getByLabelText(label)).toBeChecked();
}

/** Walks the full flow end to end, choosing the given radio options on the content step. */
async function completeFlow(modelsLabel: string, imagesLabel: string, appData = false) {
  await openContentModal();
  await choose(modelsLabel);
  await choose(imagesLabel);
  if (appData) await choose('Also delete my data in apps');
  await userEvent.click(page.getByRole('button', { name: 'Continue' }));
  await userEvent.fill(page.getByPlaceholder('Type DELETE to confirm'), 'DELETE');
  await userEvent.click(page.getByRole('button', { name: 'Delete my account' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser.value = { id: 7, muted: false };
});

// The server refuses a muted account too; this pins that the card says so up front. Every other
// case here renders an unmuted user with the button enabled, which is the control.
describe('DeleteCard for a muted account', () => {
  test('disables the button and points to the support portal', async () => {
    currentUser.value = { id: 7, muted: true };
    renderWithProviders(<DeleteCard />);

    await expect.element(page.getByRole('button', { name: 'Delete your account' })).toBeDisabled();
    await expect
      .element(page.getByRole('link', { name: 'open a ticket through our support portal' }))
      .toHaveAttribute('href', SUPPORT_LINKS.portal);
  });

  test('the settings-page variant is disabled too', async () => {
    currentUser.value = { id: 7, muted: true };
    renderWithProviders(<DeleteCard flat />);

    await expect.element(page.getByRole('button', { name: 'Delete account' })).toBeDisabled();
    await expect
      .element(page.getByRole('link', { name: 'open a ticket through our support portal' }))
      .toHaveAttribute('href', SUPPORT_LINKS.portal);
  });
});

describe('DeleteCard content step', () => {
  test('neither radio group has a default, so Continue starts disabled', async () => {
    await openContentModal();

    await expect.element(page.getByRole('radio', { name: 'Delete them' })).not.toBeChecked();
    await expect.element(page.getByRole('radio', { name: 'Delete now' })).not.toBeChecked();
    await expect.element(page.getByRole('button', { name: 'Continue' })).toBeDisabled();

    await choose('Delete them');
    await expect.element(page.getByRole('button', { name: 'Continue' })).toBeDisabled();

    await choose('Delete now');
    await expect.element(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  test('cancelling resets both radio selections and the typed confirmation', async () => {
    await openContentModal();
    await choose('Delete them');
    await choose('Delete now');
    await userEvent.click(page.getByRole('button', { name: 'Continue' }));
    await userEvent.fill(page.getByPlaceholder('Type DELETE to confirm'), 'DELETE');

    // Dismissing the confirm step (rather than cancelling from it) must still count
    // as cancelling the whole flow, or the typed DELETE strands in the box.
    await userEvent.keyboard('{Escape}');
    await userEvent.click(page.getByRole('button', { name: 'Delete your account' }));

    await expect.element(page.getByRole('radio', { name: 'Delete them' })).not.toBeChecked();
    await expect.element(page.getByRole('radio', { name: 'Delete now' })).not.toBeChecked();

    await choose('Keep them public');
    await choose('Delete after 7 days');
    await userEvent.click(page.getByRole('button', { name: 'Continue' }));

    await expect.element(page.getByPlaceholder('Type DELETE to confirm')).toHaveValue('');
    await expect.element(page.getByRole('button', { name: 'Delete my account' })).toBeDisabled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});

describe('DeleteCard confirm step summary', () => {
  test('restates deletion choices as deletion', async () => {
    await openContentModal();
    await choose('Delete them');
    await choose('Delete now');
    await userEvent.click(page.getByRole('button', { name: 'Continue' }));

    await expect.element(page.getByText('Your models will be deleted')).toBeInTheDocument();
    await expect
      .element(
        page.getByText('Your images will be deleted in the background, which can take up to a day')
      )
      .toBeInTheDocument();
  });

  test('restates keep-it choices without deletion phrasing', async () => {
    await openContentModal();
    await choose('Keep them public');
    await choose('Delete after 7 days');
    await userEvent.click(page.getByRole('button', { name: 'Continue' }));

    await expect
      .element(page.getByText('Your models will stay public under an anonymous owner'))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          'Your images will be hidden in the background within a day, then deleted after 7 days'
        )
      )
      .toBeInTheDocument();
    await expect.element(page.getByText('Your data in apps will be kept')).toBeInTheDocument();
  });

  // The summary line flips with the box (unticked: "will be kept", above).
  test('says app data goes after the 7-day grace when the box is ticked', async () => {
    await openContentModal();
    await choose('Keep them public');
    await choose('Delete after 7 days');
    await choose('Also delete my data in apps');
    await userEvent.click(page.getByRole('button', { name: 'Continue' }));

    await expect
      .element(page.getByText('Your data in apps will be deleted after 7 days'))
      .toBeInTheDocument();
  });
});

describe('DeleteCard mutation polarity', () => {
  test('Delete them + Delete now -> removeModels: true, removeImages: true', async () => {
    await completeFlow('Delete them', 'Delete now');
    expect(mutateAsync).toHaveBeenCalledWith({
      id: 7,
      removeModels: true,
      removeImages: true,
      removeAppData: false,
    });
  });

  test('Delete them + Delete after 7 days -> removeModels: true, removeImages: false', async () => {
    await completeFlow('Delete them', 'Delete after 7 days');
    expect(mutateAsync).toHaveBeenCalledWith({
      id: 7,
      removeModels: true,
      removeImages: false,
      removeAppData: false,
    });
  });

  test('Keep them public + Delete now -> removeModels: false, removeImages: true', async () => {
    await completeFlow('Keep them public', 'Delete now');
    expect(mutateAsync).toHaveBeenCalledWith({
      id: 7,
      removeModels: false,
      removeImages: true,
      removeAppData: false,
    });
  });

  test('Keep them public + Delete after 7 days -> removeModels: false, removeImages: false', async () => {
    await completeFlow('Keep them public', 'Delete after 7 days');
    expect(mutateAsync).toHaveBeenCalledWith({
      id: 7,
      removeModels: false,
      removeImages: false,
      removeAppData: false,
    });
  });

  // The app-data box is opt-in: every case above leaves it unticked and sends false.
  test('ticking "Also delete my data in apps" -> removeAppData: true', async () => {
    await completeFlow('Keep them public', 'Delete after 7 days', true);
    expect(mutateAsync).toHaveBeenCalledWith({
      id: 7,
      removeModels: false,
      removeImages: false,
      removeAppData: true,
    });
  });
});
