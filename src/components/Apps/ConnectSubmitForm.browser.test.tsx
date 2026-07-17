import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { TokenScope } from '../../shared/constants/token-scope.constants';

/**
 * W13 — /apps/submit "Connect an app" mode WIZARD. Browser-mode surface test
 * (report-only in Tekton): the client picker lists the caller's own OAuth apps
 * (app-block clients filtered out), picking one reveals a scope grid RESTRICTED to
 * that client's allowedScopes (bits outside it are disabled), a justification
 * textarea appears per checked scope, and Create-draft sends the right payload. The
 * pure config (toggle/validate/payload shaping) is unit-tested in
 * `__tests__/connectSubmitFormConfig.test.ts`.
 */

// Ceiling for the picked client: UserRead(1) | ModelsRead(4) = 5. ModelsWrite(8) is
// OUTSIDE the ceiling → its checkbox must be disabled.
const CEILING = TokenScope.UserRead | TokenScope.ModelsRead;

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  clients: [] as Array<{ id: string; name: string; allowedScopes: number }>,
}));

vi.mock('~/utils/trpc', () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    trpc: {
      oauthClient: {
        getAll: {
          useQuery: () => ({ data: mocks.clients, isLoading: false }),
        },
      },
      appListings: {
        submitConnectListing: {
          useMutation: () => ({ mutate: mocks.mutate, mutateAsync: vi.fn(), isPending: false }),
        },
        persistAssetImage: { useMutation: mutation },
        ingestAssetFromUrl: { useMutation: mutation },
        setIcon: { useMutation: mutation },
        setCover: { useMutation: mutation },
        addScreenshot: { useMutation: mutation },
      },
    },
  };
});

vi.mock('~/hooks/useCFImageUpload', () => ({
  useCFImageUpload: () => ({
    uploadToCF: vi.fn(),
    files: [],
    resetFiles: vi.fn(),
    removeImage: vi.fn(),
  }),
}));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

const { ConnectSubmitForm } = await import('./ConnectSubmitForm');

beforeEach(() => {
  mocks.mutate.mockClear();
  mocks.clients = [
    { id: 'oauth-client-1', name: 'My OAuth App', allowedScopes: CEILING },
    // App-block clients must be filtered OUT of the picker.
    { id: 'appblk-hidden', name: 'Block Client', allowedScopes: TokenScope.Full },
  ];
});

describe('ConnectSubmitForm — wizard', () => {
  test('restricts the scope grid to the selected client’s allowedScopes', async () => {
    renderWithProviders(<ConnectSubmitForm />);
    await page.getByTestId('apps-connect-client-select').click();
    await page.getByRole('option', { name: 'My OAuth App' }).click();

    // ModelsRead (bit 4) is in the ceiling → enabled; ModelsWrite (bit 8) is not → disabled.
    await expect.element(page.getByTestId('apps-connect-scope-4')).not.toBeDisabled();
    await expect.element(page.getByTestId('apps-connect-scope-8')).toBeDisabled();
  });

  test('a justification textarea appears per checked scope', async () => {
    renderWithProviders(<ConnectSubmitForm />);
    await page.getByTestId('apps-connect-client-select').click();
    await page.getByRole('option', { name: 'My OAuth App' }).click();

    // No justification textarea before any scope is checked.
    expect(page.getByTestId('apps-connect-justification-4').elements()).toHaveLength(0);

    await page.getByTestId('apps-connect-scope-4').click();
    await expect.element(page.getByTestId('apps-connect-justification-4')).toBeInTheDocument();
  });

  test('Create-draft sends the connectClientId + requestedScopes + justifications', async () => {
    renderWithProviders(<ConnectSubmitForm />);
    await page.getByTestId('apps-connect-client-select').click();
    await page.getByRole('option', { name: 'My OAuth App' }).click();
    await page.getByTestId('apps-connect-scope-4').click();
    await page.getByTestId('apps-connect-justification-4').fill('We download models.');
    await page.getByTestId('apps-connect-wizard-next-client').click();

    await page.getByTestId('apps-connect-submit-name').fill('My Connected App');
    await page.getByTestId('apps-connect-submit-slug').fill('my-connected-app');
    await page.getByTestId('apps-connect-submit-create').click();

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'my-connected-app',
        name: 'My Connected App',
        connectClientId: 'oauth-client-1',
        requestedScopes: TokenScope.ModelsRead,
        scopeJustifications: { ModelsRead: 'We download models.' },
      })
    );
  });
});
