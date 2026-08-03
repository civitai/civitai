import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only: gives the `importOriginal` spread below the real module's type
// without an `import()` type annotation (banned by consistent-type-imports).
import type * as TrpcModule from '~/utils/trpc';

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
  meta: { data: undefined as unknown, isFetching: false, isSuccess: false } as {
    data: unknown;
    isFetching: boolean;
    isSuccess: boolean;
    isError?: boolean;
  },
  // The meta query's `refetch` — a same-url "Pull from site" re-click calls it
  // (staleTime:Infinity + retry:false makes `setMetaUrl(sameUrl)` a no-op), so we assert
  // it fired on re-click to prove the once-per-url guard is bypassed on a manual retry.
  refetch: vi.fn(),
  clients: {
    data: [{ id: 'oauth-client-1', name: 'My OAuth App', allowedScopes: 4 | 32 }] as unknown,
    isLoading: false,
  },
  // Mod-only global-search result (App-Blocks mod picker). Empty by default; the mod
  // tests set foreign clients here. `useCurrentUser` drives which picker renders.
  search: { data: { items: [] as unknown[], nextCursor: undefined }, isFetching: false } as {
    data: { items: unknown[]; nextCursor?: string };
    isFetching: boolean;
  },
  currentUser: null as null | { id: number; username: string; isModerator?: boolean },
}));

// Only the `trpc` client itself is overridden — every other `~/utils/trpc` export
// (trpcVanilla, queryClient, setTrpcBatchingEnabled, ...) is kept real via
// importOriginal. A wholesale factory silently breaks this whole FILE (0 tests
// collected, no failing assertion) the day the module gains an export some other
// file in this test's graph imports. See local-rules/no-wholesale-module-mock.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    trpc: {
      // ListingAssetStep (reached on the Assets step) calls `trpc.useUtils()` and
      // `utils.appListings.getAssetScanStatuses.fetch` on an accept — stub both.
      useUtils: () => ({
        appListings: {
          getAssetScanStatuses: { fetch: vi.fn().mockResolvedValue([]) },
        },
      }),
      appListings: {
        submitExternalListing: {
          useMutation: (opts?: { onSuccess?: (r: unknown) => void }) => {
            mocks.submit(opts);
            return {
              // On mutate, fire the caller's onSuccess so the wizard transitions to the
              // Assets step (setSubmitted + STEP_ASSETS) — the only place the captured
              // `suggestions` render. Existing tests assert the call count, unaffected.
              mutate: (vars: unknown) => {
                mocks.mutate(vars);
                opts?.onSuccess?.({
                  listingId: 'apl_new',
                  publishRequestId: 'apr_new',
                  slug: 'vitrine',
                });
              },
              mutateAsync: vi.fn(),
              isPending: false,
            };
          },
        },
        fetchListingMetaFromUrl: {
          useQuery: () => ({ ...mocks.meta, refetch: mocks.refetch }),
        },
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
        searchForModerator: { useQuery: () => mocks.search },
      },
    },
  };
});

// The OAuth picker is role-aware: mods get the async global-search control, non-mods
// the own-clients dropdown. Drive the role via a mocked `useCurrentUser` (the harness
// provides no session context, so this hook must be mocked here).
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.currentUser,
}));

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
  mocks.refetch.mockClear();
  mocks.meta = { data: undefined, isFetching: false, isSuccess: false };
  mocks.clients = {
    data: [{ id: 'oauth-client-1', name: 'My OAuth App', allowedScopes: READONLY_SCOPES }],
    isLoading: false,
  };
  mocks.search = { data: { items: [], nextCursor: undefined }, isFetching: false };
  // Default caller: NOT a moderator → own-clients dropdown (existing tests unchanged).
  mocks.currentUser = null;
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
    // Meta settles with no title → the Name autofills from the host fallback so the
    // Details step is complete and "Create draft" is enabled.
    mocks.meta = { data: {}, isFetching: false, isSuccess: true };
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl();
    await pickClient();
    await expect.element(page.getByTestId('apps-offsite-scope-empty')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-justification-1').elements()).toHaveLength(0);
    await page.getByTestId('apps-offsite-wizard-next-app').click();
    await page.getByRole('button', { name: 'Create draft' }).click();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  test('the page <title> (not the host) fills the Name; slug still derives from the host; og:description autofills the Description', async () => {
    // Regression (bug report): cosmetic-studio.civitai.com must show the real page
    // <title> "Civitai Cosmetic Studio" in Name, NOT the host-derived "Cosmetic Studio".
    mocks.meta = {
      data: {
        name: 'Civitai Cosmetic Studio',
        tagline: 'short',
        description: 'A longer description pulled from the link.',
        coverImageUrl: undefined,
        iconImageUrl: undefined,
      },
      isFetching: false,
      isSuccess: true,
    };
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl('https://cosmetic-studio.civitai.com');
    await pickClient();
    await page.getByTestId('apps-offsite-wizard-next-app').click();
    // The extracted <title> WINS over the host-derived name ("Cosmetic Studio").
    await expect
      .element(page.getByTestId('apps-offsite-submit-name'))
      .toHaveValue('Civitai Cosmetic Studio');
    // Slug still derives from the URL host (hyphenated — slugs keep hyphens).
    await expect.element(page.getByRole('textbox', { name: /^Slug/ })).toHaveValue('cosmetic-studio');
    // og:description autofills the (empty) Description field.
    await expect
      .element(page.getByTestId('apps-offsite-submit-description'))
      .toHaveValue('A longer description pulled from the link.');
    // The "we found your details" reveal is shown.
    await expect.element(page.getByTestId('apps-offsite-autofill-reveal')).toBeInTheDocument();
  });

  test('when the meta fetch returns NO title, the Name falls back to the de-hyphenated host name', async () => {
    // Settled with data but no name/title → host fallback, de-hyphenated to a space.
    mocks.meta = {
      data: {
        name: undefined,
        tagline: undefined,
        description: undefined,
        coverImageUrl: undefined,
        iconImageUrl: undefined,
      },
      isFetching: false,
      isSuccess: true,
    };
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl('https://cosmetic-studio.civitai.com');
    await pickClient();
    await page.getByTestId('apps-offsite-wizard-next-app').click();
    // No <title> → host-derived name, de-hyphenated ("Cosmetic Studio", not "Cosmetic-Studio").
    await expect
      .element(page.getByTestId('apps-offsite-submit-name'))
      .toHaveValue('Cosmetic Studio');
    await expect.element(page.getByRole('textbox', { name: /^Slug/ })).toHaveValue('cosmetic-studio');
  });

  test('when the meta fetch ERRORS, the Name still falls back to the de-hyphenated host name', async () => {
    // The fetch settling as an error must not leave Name blank — host fallback applies.
    mocks.meta = { data: undefined, isFetching: false, isSuccess: false, isError: true };
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl('https://cosmetic-studio.civitai.com');
    await pickClient();
    await page.getByTestId('apps-offsite-wizard-next-app').click();
    await expect
      .element(page.getByTestId('apps-offsite-submit-name'))
      .toHaveValue('Cosmetic Studio');
  });

  test('a Name the user already typed is never overwritten by the title or the host fallback', async () => {
    // Meta has NOT settled yet when the author reaches Details and types a name.
    mocks.meta = { data: undefined, isFetching: false, isSuccess: false, isError: false };
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl('https://cosmetic-studio.civitai.com');
    await pickClient();
    await page.getByTestId('apps-offsite-wizard-next-app').click();
    const name = page.getByTestId('apps-offsite-submit-name');
    await name.fill('User Typed Name');
    // The meta fetch now resolves WITH a <title>; force a re-render so the effect runs.
    mocks.meta = {
      data: {
        name: 'Civitai Cosmetic Studio',
        tagline: undefined,
        description: undefined,
        coverImageUrl: undefined,
        iconImageUrl: undefined,
      },
      isFetching: false,
      isSuccess: true,
    };
    await page.getByRole('textbox', { name: /^Tagline/ }).fill('trigger a re-render');
    // Neither the title nor the host fallback clobbers the typed name.
    await expect.element(name).toHaveValue('User Typed Name');
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
    // Meta settles with no title → Name autofills from the host fallback, completing Details.
    mocks.meta = { data: {}, isFetching: false, isSuccess: true };
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl();
    await pickClient();
    await page.getByTestId('apps-offsite-wizard-next-app').click();
    await page.getByRole('button', { name: 'Create draft' }).click();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });
});

describe('ExternalSubmitForm — OAuth step: mod global-search + create deeplink', () => {
  test('a NON-moderator sees the own-clients dropdown (unchanged), not the search control', async () => {
    mocks.currentUser = { id: 5, username: 'dev' }; // no isModerator
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl();
    await expect.element(page.getByTestId('apps-offsite-client-select')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-client-search').elements()).toHaveLength(0);
  });

  test('a MODERATOR sees the async global-search control, not the own-clients dropdown', async () => {
    mocks.currentUser = { id: 1, username: 'mod', isModerator: true };
    mocks.search = {
      data: { items: [], nextCursor: undefined },
      isFetching: false,
    };
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl();
    await expect.element(page.getByTestId('apps-offsite-client-search')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-client-select').elements()).toHaveLength(0);
  });

  test('a mod selecting a searched FOREIGN client derives the requested scopes from THAT client', async () => {
    // The foreign client is NOT in the caller's own list; its allowedScopes must still
    // flow into deriveScopesFromClient. UserRead=1 is SENSITIVE → its justification
    // input appearing proves the derived requestedScopes came from the foreign client.
    mocks.currentUser = { id: 1, username: 'mod', isModerator: true };
    mocks.search = {
      data: {
        items: [
          { id: 'foreign-1', name: 'Bobs App', allowedScopes: 1, user: { id: 9, username: 'bob' } },
        ],
        nextCursor: undefined,
      },
      isFetching: false,
    };
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl();
    await page.getByTestId('apps-offsite-client-search').click();
    await page.getByRole('option', { name: /Bobs App/ }).click();
    // Derived from allowedScopes=1 (UserRead, sensitive) → required justification input.
    await expect.element(page.getByTestId('apps-offsite-justification-1')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-offsite-scope-readonly')).toBeInTheDocument();
  });

  test('the "Create an OAuth client" deeplink renders for a NON-mod → /user/account in a new tab', async () => {
    mocks.currentUser = { id: 5, username: 'dev' };
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl();
    const link = page.getByTestId('apps-offsite-create-client-link');
    await expect.element(link).toBeInTheDocument();
    await expect.element(link).toHaveAttribute('href', '/user/account');
    await expect.element(link).toHaveAttribute('target', '_blank');
    await expect.element(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  test('the "Create an OAuth client" deeplink renders for a MODERATOR → /user/account in a new tab', async () => {
    mocks.currentUser = { id: 1, username: 'mod', isModerator: true };
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl();
    // ExternalSubmitForm renders `createClientLink` in TWO places by design — persistently
    // below the picker AND as the Select's `nothingFoundMessage`. For a moderator the
    // global-search Select has no results, so the nothingFound copy is mounted too and a
    // bare testid query matches 2 elements (strict-mode violation). Scope to the persistent
    // in-form one — the affordance this test is about — not the dropdown's copy.
    const link = page
      .getByTestId('apps-offsite-submit-form')
      .getByTestId('apps-offsite-create-client-link');
    await expect.element(link).toBeInTheDocument();
    await expect.element(link).toHaveAttribute('href', '/user/account');
    await expect.element(link).toHaveAttribute('target', '_blank');
    await expect.element(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  test('the mod no-results message is NON-INTERACTIVE prose — no anchor in the listbox, exactly ONE create-client control', async () => {
    // a11y REGRESSION GUARD. Mantine renders `nothingFoundMessage` as `Combobox.Empty`
    // INSIDE `Combobox.Options`, which carries `role="listbox"`. Supplying the prop also
    // flips `hiddenWhenEmpty` to false, and `Combobox` defaults to `keepMounted: true`,
    // so that node sits in the DOM (merely `display:none`) whenever the option list is
    // empty. It therefore must NOT be an anchor: `link` is not a permitted child role of
    // `listbox` and it breaks the combobox's arrow/Enter semantics while open. It also
    // must not duplicate the persistent create-client deeplink — pre-fix BOTH were the
    // same <a> with the same `data-testid`, visible at once on exactly the no-results
    // path this message exists for (and a bare testid query matched 2 → strict-mode
    // violation). Moderators are the only role whose picker can reach an empty list.
    mocks.currentUser = { id: 1, username: 'mod', isModerator: true };
    mocks.search = { data: { items: [], nextCursor: undefined }, isFetching: false };
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl();

    // Open the picker so this is the state a moderator actually sees, not just the DOM.
    await page.getByTestId('apps-offsite-client-search').click();

    const empty = page.getByTestId('apps-offsite-client-search-empty');
    await expect.element(empty).toBeInTheDocument();

    // The empty-state copy carries no interactive control of its own…
    expect(empty.element().querySelector('a,button,[role="link"],[role="button"]')).toBeNull();
    // …and NO anchor is rendered inside the listbox at all.
    expect(document.querySelector('[role="listbox"] a')).toBeNull();

    // Exactly ONE "create an OAuth client" control in the document — the persistent
    // in-form deeplink, which stays a real working link.
    const links = page.getByTestId('apps-offsite-create-client-link');
    expect(links.elements()).toHaveLength(1);
    await expect.element(links).toHaveAttribute('href', '/user/account');
  });
});

/**
 * Auto-trigger + inline status + assets-step "Re-pull from site" (create wizard).
 * The manual "Pull from site" button was REMOVED: entering a valid https URL now
 * auto-fires the OG pull (on blur / advance), a subtle inline status reports the
 * four-state outcome (applied / partial / empty / error), and the assets step carries
 * the sole manual retry. Also covers the inline data-URI icon suggestion (radio case).
 */
describe('ExternalSubmitForm — auto-trigger, status, re-pull, data-URI icon', () => {
  /** Fill a URL + advance to the App step (blur auto-fires the pull). */
  async function fillUrlAndAdvance(url: string) {
    await page.getByTestId('apps-offsite-submit-url').fill(url);
    await page.getByTestId('apps-offsite-submit-url').element().blur();
    await page.getByTestId('apps-offsite-wizard-next-url').click();
  }
  /** Drive URL → App → Details → create draft → Assets. */
  async function reachAssets() {
    await pickClient();
    await page.getByTestId('apps-offsite-wizard-next-app').click();
    await page.getByRole('button', { name: 'Create draft' }).click();
  }

  test('the manual "Pull from site" button is GONE (auto-trigger replaces it)', async () => {
    renderWithProviders(<ExternalSubmitForm />);
    await page.getByTestId('apps-offsite-submit-url').fill('https://vitrine.civitai.com');
    expect(page.getByTestId('apps-offsite-submit-autofill').elements()).toHaveLength(0);
  });

  test('entering a valid URL auto-fires the pull (on blur): fills empty name/description + shows the applied note', async () => {
    mocks.meta = {
      data: {
        name: 'Civitai Cosmetic Studio',
        tagline: 'short',
        description: 'Pulled from the link.',
        coverImageUrl: 'https://cdn/og-cover.png',
        iconImageUrl: 'https://cdn/og-icon.png',
      },
      isFetching: false,
      isSuccess: true,
    };
    renderWithProviders(<ExternalSubmitForm />);
    await page.getByTestId('apps-offsite-submit-url').fill('https://cosmetic-studio.civitai.com');
    await page.getByTestId('apps-offsite-submit-url').element().blur();
    // The applied note appears WITHOUT any button click — the pull auto-fired on blur.
    await expect
      .element(page.getByTestId('apps-offsite-submit-autofill-applied'))
      .toBeInTheDocument();
    // The OAuth picker lives on the SECOND (App) step — advance before `pickClient()`,
    // which otherwise waits out its timeout on a control that is not mounted yet. (The
    // fill+blur above is deliberately inlined rather than using `fillUrlAndAdvance` so the
    // assertion above proves the pull fired on BLUR, with no button click.)
    await page.getByTestId('apps-offsite-wizard-next-url').click();
    await pickClient();
    await page.getByTestId('apps-offsite-wizard-next-app').click();
    await expect
      .element(page.getByTestId('apps-offsite-submit-name'))
      .toHaveValue('Civitai Cosmetic Studio');
    await expect
      .element(page.getByTestId('apps-offsite-submit-description'))
      .toHaveValue('Pulled from the link.');
  });

  test('a site exposing SOME channels shows the honest PARTIAL note (radio: title + icon, no cover/description)', async () => {
    mocks.meta = {
      data: {
        name: 'AI Radio',
        iconDataUri: 'data:image/svg+xml,%3Csvg%2F%3E',
      },
      isFetching: false,
      isSuccess: true,
    };
    renderWithProviders(<ExternalSubmitForm />);
    await page.getByTestId('apps-offsite-submit-url').fill('https://radio.example.com');
    await page.getByTestId('apps-offsite-submit-url').element().blur();
    await expect
      .element(page.getByTestId('apps-offsite-submit-autofill-partial'))
      .toBeInTheDocument();
    // NOT a spurious applied/empty.
    expect(page.getByTestId('apps-offsite-submit-autofill-applied').elements()).toHaveLength(0);
  });

  test('a site that exposed NOTHING (SPA #3344) shows the honest empty note — never "already filled"', async () => {
    mocks.meta = { data: {}, isFetching: false, isSuccess: true };
    renderWithProviders(<ExternalSubmitForm />);
    await page.getByTestId('apps-offsite-submit-url').fill('https://spa.example.com');
    await page.getByTestId('apps-offsite-submit-url').element().blur();
    await expect
      .element(page.getByTestId('apps-offsite-submit-autofill-empty'))
      .toBeInTheDocument();
  });

  test('an ERRORED pull shows the error note (no spurious applied/empty/partial)', async () => {
    mocks.meta = { data: undefined, isFetching: false, isSuccess: false, isError: true };
    renderWithProviders(<ExternalSubmitForm />);
    await page.getByTestId('apps-offsite-submit-url').fill('https://broken.example.com');
    await page.getByTestId('apps-offsite-submit-url').element().blur();
    await expect
      .element(page.getByTestId('apps-offsite-submit-autofill-error'))
      .toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-submit-autofill-applied').elements()).toHaveLength(0);
    expect(page.getByTestId('apps-offsite-submit-autofill-empty').elements()).toHaveLength(0);
  });

  test('the pulled https icon/cover suggestions flow to the Assets step (Use this previews)', async () => {
    mocks.meta = {
      data: {
        name: 'Vitrine',
        coverImageUrl: 'https://cdn/og-cover.png',
        iconImageUrl: 'https://cdn/og-icon.png',
      },
      isFetching: false,
      isSuccess: true,
    };
    renderWithProviders(<ExternalSubmitForm />);
    await fillUrlAndAdvance('https://vitrine.civitai.com');
    await reachAssets();
    await expect.element(page.getByTestId('apps-offsite-accept-icon')).toBeInTheDocument();
    await expect.element(page.getByTestId('apps-offsite-accept-cover')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-offsite-suggested-icon-preview'))
      .toBeInTheDocument();
  });

  test('an inline data-URI icon (radio) surfaces as an icon "Use this" tile on the Assets step', async () => {
    mocks.meta = {
      data: {
        name: 'AI Radio',
        iconDataUri: 'data:image/svg+xml,%3Csvg%2F%3E',
      },
      isFetching: false,
      isSuccess: true,
    };
    renderWithProviders(<ExternalSubmitForm />);
    await fillUrlAndAdvance('https://radio.example.com');
    await reachAssets();
    // The inline data-URI icon offers an accept tile even though there's no https icon URL.
    await expect.element(page.getByTestId('apps-offsite-accept-icon')).toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-offsite-suggested-icon-preview'))
      .toBeInTheDocument();
    // No cover suggestion (the site exposed none).
    expect(page.getByTestId('apps-offsite-accept-cover').elements()).toHaveLength(0);
  });

  test('the assets-step "Re-pull from site" button invokes repull (refetch of the current url)', async () => {
    mocks.meta = {
      data: {
        name: 'Vitrine',
        coverImageUrl: 'https://cdn/og-cover.png',
        iconImageUrl: 'https://cdn/og-icon.png',
      },
      isFetching: false,
      isSuccess: true,
    };
    renderWithProviders(<ExternalSubmitForm />);
    await fillUrlAndAdvance('https://vitrine.civitai.com');
    await reachAssets();
    const repull = page.getByTestId('apps-offsite-assets-repull');
    await expect.element(repull).toBeInTheDocument();
    // The URL was fired via setMetaUrl (new url), so a repull of the SAME url must
    // refetch — proving the button re-runs the query.
    mocks.refetch.mockClear();
    await repull.click();
    await vi.waitFor(() => expect(mocks.refetch).toHaveBeenCalled());
  });

  test('does NOT clobber a name the user already typed', async () => {
    // Reach Details with no meta applied, type a name, then a later settled pull must not clobber.
    mocks.meta = { data: undefined, isFetching: false, isSuccess: false };
    renderWithProviders(<ExternalSubmitForm />);
    await advanceFromUrl('https://vitrine.civitai.com');
    await pickClient();
    await page.getByTestId('apps-offsite-wizard-next-app').click();
    await page.getByTestId('apps-offsite-submit-name').fill('User Typed Name');
    // A later re-render with settled meta carrying a title must respect the typed name.
    mocks.meta = {
      data: { name: 'OG Title' },
      isFetching: false,
      isSuccess: true,
    };
    await page.getByRole('textbox', { name: /^Tagline/ }).fill('trigger a re-render');
    await expect
      .element(page.getByTestId('apps-offsite-submit-name'))
      .toHaveValue('User Typed Name');
  });
});
