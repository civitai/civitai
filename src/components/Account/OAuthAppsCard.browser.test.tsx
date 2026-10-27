import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showErrorNotification: vi.fn(),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'oauthClient.getAll': { useQuery: () => ({ data: [], isLoading: false }) },
    'oauthClient.create': { useMutation: () => ({ mutate, isPending: false }) },
  }),
}));

import { OAuthAppsCard } from '~/components/Account/OAuthAppsCard';
import { TokenScope } from '~/shared/constants/token-scope.constants';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OAuthAppsCard register scope', () => {
  test('starting from Full and unticking all but one box registers exactly that one scope', async () => {
    renderWithProviders(<OAuthAppsCard />);
    await userEvent.click(page.getByRole('button', { name: 'Register App' }).first());
    const dialog = page.getByRole('dialog');
    await userEvent.fill(dialog.getByPlaceholder('My Application'), 'my app');
    await userEvent.fill(dialog.getByLabelText('Redirect URIs'), 'https://example.com/callback');

    const boxes = dialog.getByRole('checkbox').elements() as HTMLInputElement[];
    expect(boxes.length).toBeGreaterThan(1);
    // The first grid checkbox is Profile & Settings → Read.
    for (const box of boxes.slice(1)) await userEvent.click(box);
    await userEvent.click(dialog.getByRole('button', { name: 'Register App' }));

    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect((mutate.mock.calls[0][0] as { allowedScopes: number }).allowedScopes).toBe(
      TokenScope.UserRead
    );
  });
});
