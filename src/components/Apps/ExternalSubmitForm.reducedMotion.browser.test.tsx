import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';

/**
 * W13 — the redesigned submit wizard must honour `prefers-reduced-motion`. With the
 * shared `useReducedMotion` hook forced true, the {@link FadeIn} primitive renders
 * its children directly (no Mantine `Transition`, no animation) — this asserts the
 * whole wizard still renders + advances with motion disabled (accessibility path).
 * Only `useReducedMotion` is overridden; every other `@mantine/hooks` export stays
 * real so `useDisclosure` (the collapse) and Mantine core keep working.
 */

vi.mock('@mantine/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantine/hooks')>();
  return { ...actual, useReducedMotion: () => true };
});

const mocks = vi.hoisted(() => ({
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
          useMutation: () => ({ mutate: mocks.mutate, mutateAsync: vi.fn(), isPending: false }),
        },
        fetchListingMetaFromUrl: { useQuery: () => mocks.meta },
        persistAssetImage: { useMutation: mutation },
        ingestAssetFromUrl: { useMutation: mutation },
        ingestAssetFromDataUri: { useMutation: mutation },
        setIcon: { useMutation: mutation },
        setCover: { useMutation: mutation },
        addScreenshot: { useMutation: mutation },
        removeScreenshot: { useMutation: mutation },
      },
      oauthClient: {
        getAll: { useQuery: () => mocks.clients },
        // The OAuth picker is role-aware and calls BOTH hooks unconditionally (rules of
        // hooks) — the moderator global-search one too, even for a non-mod caller. Omitted
        // from a wholesale trpc mock it reads `undefined.useQuery` and throws during
        // render, so nothing mounts. Mirrors ExternalSubmitForm.browser.test.tsx.
        searchForModerator: { useQuery: () => ({ data: { items: [] }, isFetching: false }) },
      },
    },
  };
});

// `ExternalSubmitForm` reads `useCurrentUser` to pick which OAuth-client picker to render,
// and that hook THROWS ("missing CivitaiSessionContext") because the harness mounts no
// session context. Unmocked it takes the whole render down (empty <body>) and every
// assertion below fails by burning its timeout. `null` = the non-moderator path, which is
// the own-clients `apps-offsite-client-select` dropdown this test drives.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/hooks/useCFImageUpload', () => ({
  useCFImageUpload: () => ({ uploadToCF: vi.fn(), files: [], resetFiles: vi.fn(), removeImage: vi.fn() }),
}));

vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

const { ExternalSubmitForm } = await import('./ExternalSubmitForm');

beforeEach(() => {
  mocks.mutate.mockClear();
  mocks.meta = { data: undefined, isFetching: false, isSuccess: false };
  mocks.clients = {
    data: [{ id: 'oauth-client-1', name: 'My OAuth App', allowedScopes: 4 | 32 }],
    isLoading: false,
  };
});

describe('ExternalSubmitForm — reduced motion', () => {
  test('renders and advances every step with animation disabled', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    // Step 0 renders (FadeIn short-circuits to a plain wrapper under reduced motion).
    await expect.element(page.getByTestId('apps-offsite-submit-url')).toBeInTheDocument();
    await page.getByTestId('apps-offsite-submit-url').fill('https://vitrine.civitai.com');
    await page.getByTestId('apps-offsite-submit-url').element().blur();
    await page.getByTestId('apps-offsite-wizard-next-url').click();
    // Step 1 (App & scopes) renders without motion.
    await page.getByTestId('apps-offsite-client-select').click();
    await page.getByRole('option', { name: 'My OAuth App' }).click();
    await page.getByTestId('apps-offsite-wizard-next-app').click();
    // Step 2 (Details) renders and the Create-draft button is present.
    await expect.element(page.getByRole('button', { name: 'Create draft' })).toBeInTheDocument();
  });
});
