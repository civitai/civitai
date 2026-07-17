import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * BlockConsentModal — the lazy-consent surface a logged-in viewer sees when a
 * block requests consent-gated scopes it doesn't yet carry (REQUEST_CONSENT).
 * This suite pins that SENSITIVE requested scopes are visually emphasised for
 * the END USER (the reusable "Sensitive" indicator) while normal scopes are not.
 *
 * The modal reads its open/close props from `useDialogContext` and grants via
 * `trpc.blocks.grantScopes` — both stubbed so the render stays network-free.
 */

vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: vi.fn(), zIndex: 200 }),
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    blocks: {
      grantScopes: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
  },
}));

const { default: BlockConsentModal } = await import('./BlockConsentModal');

describe('BlockConsentModal — sensitive scope emphasis for the end user', () => {
  test('a sensitive requested scope shows the "Sensitive" indicator; a normal one does not', async () => {
    renderWithProviders(
      <BlockConsentModal
        appBlockId="app-1"
        blockName="Tip Jar"
        // one sensitive (spends Buzz) + one normal (reads username).
        missingScopes={['social:tip:self', 'user:read:self']}
        onGranted={vi.fn()}
      />
    );
    // Friendly descriptions of both requested scopes render.
    await expect.element(page.getByText('Post tips on behalf of the viewer')).toBeInTheDocument();
    await expect
      .element(page.getByText("Read the viewer's username and account status"))
      .toBeInTheDocument();
    // Exactly ONE sensitive badge — for the Buzz-spending scope only.
    expect(page.getByTestId('sensitive-scope-badge').elements()).toHaveLength(1);
    // The Allow action is present.
    await expect.element(page.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
  });

  test('renders no sensitive indicator when every requested scope is normal', async () => {
    renderWithProviders(
      <BlockConsentModal
        appBlockId="app-2"
        blockName="Model Viewer"
        missingScopes={['models:read:self', 'user:read:self']}
        onGranted={vi.fn()}
      />
    );
    await expect
      .element(page.getByText('Read the model on the page where the block is mounted'))
      .toBeInTheDocument();
    expect(page.getByTestId('sensitive-scope-badge').elements()).toHaveLength(0);
  });
});
