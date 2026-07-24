import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W13 — /apps/submit external-app WIZARD (redesigned, MERGED external+connect model).
 * Browser-mode surface test (report-only in Tekton). New step order:
 *
 *   App URL (first, REQUIRED) → App & scopes → Details → Assets
 *
 * Covers: the App URL gates step 1 (required https); the OAuth picker + SENSITIVE-only
 * justification model (sensitive scopes get a required input + badge, non-sensitive
 * scopes collapse with no inputs); the empty-scopes app submits; and the URL autofill
 * prefills name/slug/description. Pure derivation / gating / payload shaping are
 * unit-tested in `__tests__/offsiteSubmitFormConfig.oauth-fields.test.ts`.
 */

// TokenScope bits: UserRead=1 (sensitive), ModelsRead=4 (non-sensitive),
// MediaRead=32 (non-sensitive). Read-only combo (36) has NO sensitive scope.
const READONLY_SCOPES = 4 | 32; // ModelsRead | MediaRead

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  mutate: vi.fn(),
  meta: { data: undefined as unknown, isFetching: false, isSuccess: false },
  clients: {
    data: [{ id: 'oauth-client-1', name: 'My OAuth App', allowedScopes: 4 | 32 }] as unknown,
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
    data: [{ id: 'oauth-client-1', name: 'My OAuth App', allowedScopes: READONLY_SCOPES }],
    isLoading: false,
  };
});

/** Fill a valid App URL on step 0 and advance to the App & scopes step. */
async function advanceFromUrl(url = 'https://vitrine.civitai.com') {
  await page.getByTestId('apps-offsite-submit-url').fill(url);
  await page.getByTestId('apps-offsite-submit-url').element().blur();
  await page.getByTestId('apps-offsite-wizard-next-url').click();
}

/** Select the (only) OAuth client via the Mantine Select combobox (on the App step). */
async function pickClient() {
  await page.getByTestId('apps-offsite-client-select').click();
  await page.getByRole('option', { name: 'My OAuth App' }).click();
}

describe('ExternalSubmitForm — redesigned wizard', () => {
  test('starts on the App URL step (first + required); no OAuth picker yet', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    await expect.element(page.getByTestId('apps-offsite-submit-url')).toBeInTheDocument();
    // The App URL input carries the accessible "App URL" label.
    await expect.element(page.getByRole('textbox', { name: /App URL/ })).toBeInTheDocument();
    // The OAuth picker lives on the SECOND step — not rendered yet.
    expect(page.getByTestId('apps-offsite-client-select').elements()).toHaveLength(0);
  });

  test('the App URL is REQUIRED — Next is disabled until a valid https URL is entered', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    const next = page.getByTestId('apps-offsite-wizard-next-url');
    await expect.element(next).toBeDisabled();
    // A non-https URL keeps it disabled.
    await page.getByTestId('apps-offsite-submit-url').fill('http://insecure.example.com');
    await expect.element(next).toBeDisabled();
    // A valid https URL enables it.
    await page.getByTestId('apps-offsite-submit-url').fill('https://vitrine.civitai.com');
    await expect.element(next).toBeEnabled();
  });

  test('the empty-clients state renders on the App step after advancing from the URL', async () => {
    mocks.clients = { data: [], isLoading: false };
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl();
    await expect.element(page.getByTestId('apps-offsite-no-clients')).toBeInTheDocument();
  });

  test('a client with non-sensitive scopes reaches Details (no justification required)', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl();
    await pickClient();
    // Non-sensitive scopes are collapsed with NO justification inputs.
    await expect.element(page.getByTestId('apps-offsite-scope-other-toggle')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-justification-4').elements()).toHaveLength(0);
    // Next is enabled (nothing required) → Details is reachable.
    await page.getByTestId('apps-offsite-wizard-next-app').click();
    await expect.element(page.getByRole('button', { name: 'Create draft' })).toBeInTheDocument();
  });

  test('non-sensitive scopes are behind a keyboard-accessible collapse (no inputs)', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl();
    await pickClient();
    const toggle = page.getByTestId('apps-offsite-scope-other-toggle');
    await expect.element(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect.element(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect.element(page.getByTestId('apps-offsite-scope-other-list')).toBeInTheDocument();
  });

  test('a SENSITIVE scope shows a required input + badge and BLOCKS advancing until justified', async () => {
    mocks.clients = {
      data: [{ id: 'oauth-client-1', name: 'My OAuth App', allowedScopes: 1 }], // UserRead (sensitive)
      isLoading: false,
    };
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl();
    await pickClient();
    await expect.element(page.getByTestId('apps-offsite-scope-readonly')).toBeInTheDocument();
    expect(page.getByTestId('sensitive-scope-badge').elements().length).toBeGreaterThan(0);
    // The picker is gone — no checkboxes.
    expect(page.getByRole('checkbox').elements()).toHaveLength(0);
    // Sensitive scope has a required justification input (UserRead = bit 1).
    await expect.element(page.getByTestId('apps-offsite-justification-1')).toBeInTheDocument();
    // Next is BLOCKED until the sensitive justification is filled.
    await expect.element(page.getByTestId('apps-offsite-wizard-next-app')).toBeDisabled();
    await page.getByTestId('apps-offsite-justification-1').fill('reads the profile to greet the user');
    await expect.element(page.getByTestId('apps-offsite-wizard-next-app')).toBeEnabled();
  });

  test('an empty-scopes OAuth app shows the no-scopes state and submits cleanly', async () => {
    mocks.clients = {
      data: [{ id: 'oauth-client-1', name: 'My OAuth App', allowedScopes: 0 }],
      isLoading: false,
    };
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl();
    await pickClient();
    await expect.element(page.getByTestId('apps-offsite-scope-empty')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-justification-1').elements()).toHaveLength(0);
    await page.getByTestId('apps-offsite-wizard-next-app').click();
    await page.getByRole('button', { name: 'Create draft' }).click();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  test('the App URL prefills name + slug on Details, and og:description autofills the Description', async () => {
    mocks.meta = {
      data: {
        name: 'OG Name',
        tagline: 'short',
        description: 'A longer description pulled from the link.',
        coverImageUrl: undefined,
        iconImageUrl: undefined,
      },
      isFetching: false,
      isSuccess: true,
    };
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl('https://vitrine.civitai.com');
    await pickClient();
    await page.getByTestId('apps-offsite-wizard-next-app').click();
    // Name/slug derive from the URL host (filled before the OG name, non-clobber).
    await expect.element(page.getByRole('textbox', { name: /^Name/ })).toHaveValue('Vitrine');
    await expect.element(page.getByRole('textbox', { name: /^Slug/ })).toHaveValue('vitrine');
    // og:description autofills the (empty) Description field.
    await expect
      .element(page.getByTestId('apps-offsite-submit-description'))
      .toHaveValue('A longer description pulled from the link.');
    // The "we found your details" reveal is shown.
    await expect.element(page.getByTestId('apps-offsite-autofill-reveal')).toBeInTheDocument();
  });

  test('autofill does NOT clobber a description the user already typed', async () => {
    mocks.meta = {
      data: { name: undefined, tagline: undefined, description: 'OG desc', coverImageUrl: undefined, iconImageUrl: undefined },
      isFetching: false,
      isSuccess: true,
    };
    renderWithProviders(<ExternalSubmitForm />);
    // Advance to Details first WITHOUT a URL-triggered meta apply, type a description,
    // then go back to URL and re-advance to fire the autofill — it must not clobber.
    await advanceFromUrl('https://vitrine.civitai.com');
    await pickClient();
    await page.getByTestId('apps-offsite-wizard-next-app').click();
    const desc = page.getByTestId('apps-offsite-submit-description');
    await desc.fill('my own words');
    // The meta already applied on first advance; ensure the typed value stands.
    await expect.element(desc).toHaveValue('my own words');
  });

  test('submitting valid details calls submitExternalListing (server owns the draft)', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl();
    await pickClient();
    await page.getByTestId('apps-offsite-wizard-next-app').click();
    await page.getByRole('button', { name: 'Create draft' }).click();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });
});
