import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W13 — /apps/submit external-app WIZARD (the MERGED external+connect model). Browser
 * -mode surface test (report-only in Tekton): the stepper starts on the "App & scopes"
 * step with the OAuth-app picker; the homepage URL is now an OPTIONAL field on that
 * step; once a client is chosen the Next button enables and Details is reachable;
 * entering a homepage URL prefills name + slug on Details; and a valid Details submit
 * calls `submitExternalListing`. The pure derivation / normalization / step-gating /
 * payload shaping are unit-tested in `__tests__/deriveListingFromUrl.test.ts`,
 * `__tests__/normalizeLinkUrl.test.ts` and
 * `__tests__/offsiteSubmitFormConfig.oauth-fields.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  mutate: vi.fn(),
  // The metadata auto-pull query result the mocked `fetchListingMetaFromUrl` returns.
  meta: { data: undefined as unknown, isFetching: false, isSuccess: false },
  // The caller's OAuth clients (`oauthClient.getAll`). Tests mutate this.
  clients: {
    data: [{ id: 'oauth-client-1', name: 'My OAuth App', allowedScopes: 0xffff }] as unknown,
    isLoading: false,
  },
}));

vi.mock('~/utils/trpc', () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    trpc: {
      appListings: {
        submitExternalListing: {
          useMutation: (opts?: unknown) => {
            mocks.submit(opts);
            return { mutate: mocks.mutate, mutateAsync: vi.fn(), isPending: false };
          },
        },
        fetchListingMetaFromUrl: {
          useQuery: () => mocks.meta,
        },
        persistAssetImage: { useMutation: mutation },
        ingestAssetFromUrl: { useMutation: mutation },
        setIcon: { useMutation: mutation },
        setCover: { useMutation: mutation },
        addScreenshot: { useMutation: mutation },
      },
      oauthClient: {
        getAll: { useQuery: () => mocks.clients },
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

const { ExternalSubmitForm } = await import('./ExternalSubmitForm');

beforeEach(() => {
  mocks.submit.mockClear();
  mocks.mutate.mockClear();
  mocks.meta = { data: undefined, isFetching: false, isSuccess: false };
  mocks.clients = {
    data: [{ id: 'oauth-client-1', name: 'My OAuth App', allowedScopes: 0xffff }],
    isLoading: false,
  };
});

/** Select the (only) OAuth client via the Mantine Select combobox. */
async function pickClient() {
  await page.getByTestId('apps-offsite-client-select').click();
  await page.getByRole('option', { name: 'My OAuth App' }).click();
}

describe('ExternalSubmitForm — merged wizard', () => {
  test('starts on the "App & scopes" step with the OAuth-app picker + optional homepage URL', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    await expect.element(page.getByTestId('apps-offsite-client-select')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-offsite-submit-url')).toBeInTheDocument();
    // The homepage URL field advertises that it is optional.
    await expect.element(page.getByText(/Homepage link \(optional\)/i)).toBeInTheDocument();
    // The Create-draft button lives on the Details step and is not rendered yet.
    expect(page.getByRole('button', { name: 'Create draft' }).elements()).toHaveLength(0);
  });

  test('the empty-clients state renders when the user has no eligible OAuth apps', async () => {
    mocks.clients = { data: [], isLoading: false };
    renderWithProviders(<ExternalSubmitForm />);
    await expect.element(page.getByTestId('apps-offsite-no-clients')).toBeInTheDocument();
  });

  test('choosing a client enables Next and reaches the Details step', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    await pickClient();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect.element(page.getByRole('button', { name: 'Create draft' })).toBeInTheDocument();
  });

  test('picking a client shows the derived scopes READ-ONLY (no checkbox picker) with the sensitive badge', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    await pickClient();
    // Scopes are auto-derived from the client — a read-only list, no picker.
    await expect.element(page.getByTestId('apps-offsite-scope-readonly')).toBeInTheDocument();
    expect(page.getByRole('checkbox').elements()).toHaveLength(0);
    // 0xffff includes sensitive scopes (UserRead / *Write) → the badge is surfaced.
    expect(page.getByTestId('sensitive-scope-badge').elements().length).toBeGreaterThan(0);
    // A per-scope justification input is rendered (UserRead = bit 1).
    await expect.element(page.getByTestId('apps-offsite-justification-1')).toBeInTheDocument();
  });

  test('an empty-scopes OAuth app shows the no-scopes state and submits cleanly', async () => {
    mocks.clients = {
      data: [{ id: 'oauth-client-1', name: 'My OAuth App', allowedScopes: 0 }],
      isLoading: false,
    };
    renderWithProviders(<ExternalSubmitForm />);
    await pickClient();
    await expect.element(page.getByTestId('apps-offsite-scope-empty')).toBeInTheDocument();
    // No justification inputs, still a valid submission.
    expect(page.getByTestId('apps-offsite-justification-1').elements()).toHaveLength(0);
    await page.getByTestId('apps-offsite-submit-url').fill('https://vitrine.civitai.com');
    await page.getByTestId('apps-offsite-submit-url').element().blur();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Create draft' }).click();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  test('an optional homepage URL prefills name + slug on Details', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    await pickClient();
    await page.getByTestId('apps-offsite-submit-url').fill('https://vitrine.civitai.com');
    // Blur to normalize + prefill.
    await page.getByTestId('apps-offsite-submit-url').element().blur();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect.element(page.getByRole('textbox', { name: /^Name/ })).toHaveValue('Vitrine');
    await expect.element(page.getByRole('textbox', { name: /^Slug/ })).toHaveValue('vitrine');
  });

  test('submitting valid details calls submitExternalListing (server owns the draft)', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    await pickClient();
    await page.getByTestId('apps-offsite-submit-url').fill('https://vitrine.civitai.com');
    await page.getByTestId('apps-offsite-submit-url').element().blur();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Create draft' }).click();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });
});
