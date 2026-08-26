import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { MATERIAL_LISTING_PATCH_FIELDS } from '~/shared/constants/app-capabilities.constants';
import type * as TrpcModule from '~/utils/trpc';
import type { ListingEditContext } from './offsiteEditConfig';

/**
 * THE EDIT WIZARD ON AN OWNER-UNPUBLISHED LISTING — the MATERIAL fields must be visible
 * and NOT editable.
 *
 * 🔴 WHY THIS IS A DEFECT AND NOT A NICETY. `updateListing`'s `removed` branch refuses any
 * change to a field in `MATERIAL_LISTING_PATCH_FIELDS` with `MATERIAL_CHANGE_BLOCKED`
 * (→ BAD_REQUEST), and it refuses it AFTER the author has typed the change and pressed
 * Save. That refusal was unreachable while no editor tab opened on this status; opening the
 * Details tab without this makes it four boxes the author can fill and can never save,
 * discovering the rule only from a red toast. An editable input that can never save is
 * worse than a hidden one.
 *
 * 🔴 THE PREFILL STAYS WIDER THAN THE WRITE, DELIBERATELY. The author must be able to READ
 * their current name, URL, repository and rating — those values are what they are deciding
 * whether to republish. Showing a value is a different act from offering an edit of it, and
 * these cases pin the difference: the inputs are IN the document, carrying their real
 * values, and disabled.
 *
 * 🔴 THE LEDGER CASE IS THE ONE THAT SURVIVES FUTURE CHANGE. It walks
 * `MATERIAL_LISTING_PATCH_FIELDS` — the SAME constant `offsite-listing.service` refuses on —
 * and demands a disabled input per member, so a field added to the server's material set
 * with no counterpart here goes red instead of shipping another unsaveable box.
 */

const mocks = vi.hoisted(() => ({
  meta: { data: undefined, isFetching: false, isError: false, isSuccess: false } as {
    data?: unknown;
    isFetching?: boolean;
    isError?: boolean;
    isSuccess?: boolean;
  },
  refetch: vi.fn(),
  updateListing: vi.fn(),
  updateRevision: vi.fn(),
  submitRevision: vi.fn(),
  invalidate: vi.fn(),
}));

// Spread the REAL module and override only `trpc` (per `local-rules/no-wholesale-module-mock`):
// a hand-written replacement silently drops any export a transitive importer needs, and the
// whole file then fails to load as "0 tests collected" — green for the worst possible reason.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  const noopMutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  });
  const recording = (fn: (v: unknown) => void, result: unknown = {}) => () => ({
    mutate: vi.fn(),
    mutateAsync: (vars: unknown) => {
      fn(vars);
      return Promise.resolve(result);
    },
    isPending: false,
  });
  return {
    ...actual,
    trpc: {
      useUtils: () => ({
        appListings: {
          listMySubmissions: { invalidate: mocks.invalidate },
          getMyListingForEdit: { invalidate: mocks.invalidate },
        },
      }),
      appListings: {
        fetchListingMetaFromUrl: { useQuery: () => ({ ...mocks.meta, refetch: mocks.refetch }) },
        updateListing: { useMutation: recording(mocks.updateListing) },
        updateRevisionDraft: { useMutation: recording(mocks.updateRevision) },
        submitListingRevision: { useMutation: recording(mocks.submitRevision) },
        removeScreenshot: { useMutation: noopMutation },
        persistAssetImage: { useMutation: noopMutation },
        ingestAssetFromUrl: { useMutation: noopMutation },
        ingestAssetFromDataUri: { useMutation: noopMutation },
        setIcon: { useMutation: noopMutation },
        setCover: { useMutation: noopMutation },
        addScreenshot: { useMutation: noopMutation },
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

function makeCtx(overrides: Partial<ListingEditContext> = {}): ListingEditContext {
  return {
    parentId: 'apl_parent',
    slug: 'vitrine',
    status: 'removed',
    hasPendingRevision: false,
    shadowId: null,
    scalars: {
      name: 'Vitrine',
      tagline: 'A gallery',
      description: 'desc',
      category: 'utility',
      contentRating: 'g',
      externalUrl: 'https://vitrine.civitai.com/',
      sourceRepoUrl: 'https://github.com/civitai/vitrine',
    },
    assets: {
      icon: { imageId: 10, url: 'https://cdn/icon.png' },
      cover: { imageId: 20, url: 'https://cdn/cover.png' },
      screenshots: [],
    },
    ...overrides,
  };
}

/**
 * The form control carrying a `data-material-field` tag. Mantine spreads unknown props onto
 * the underlying input, so this is normally the input itself; the fallback covers a control
 * whose tag lands on a wrapper, so the ledger cannot pass by finding a DIV that is trivially
 * "not enabled".
 */
function materialControl(field: string): HTMLInputElement | HTMLSelectElement | null {
  const tagged = document.querySelector<HTMLElement>(`[data-material-field="${field}"]`);
  if (!tagged) return null;
  if (tagged instanceof HTMLInputElement || tagged instanceof HTMLSelectElement) return tagged;
  return tagged.querySelector<HTMLInputElement>('input, select');
}

beforeEach(() => {
  mocks.meta = { data: undefined, isFetching: false, isError: false, isSuccess: false };
  mocks.refetch.mockClear();
  mocks.updateListing.mockClear();
  mocks.updateRevision.mockClear();
  mocks.submitRevision.mockClear();
  mocks.invalidate.mockClear();
});

describe('🔴 an OWNER-UNPUBLISHED listing: material fields are shown, and locked', () => {
  test('🔴 the reason is on screen BEFORE the author reaches a locked field', async () => {
    renderWithProviders(<ExternalSubmitForm edit={makeCtx()} />);
    const notice = page.getByTestId('apps-offsite-edit-material-locked-notice');
    await expect.element(notice).toBeInTheDocument();
    // It states the refusal AND the way out — an author told only "no" has nowhere to go.
    await expect.element(notice).toHaveTextContent(/republish/i);
    await expect.element(notice).toHaveTextContent(/moderator review/i);
    // And what is STILL editable, so the tab is not read as entirely dead.
    await expect.element(notice).toHaveTextContent(/tagline, description and category/i);
  });

  test('🔴 EVERY material field the server refuses has a DISABLED input — the ledger', async () => {
    // Walks the SERVER's own constant. `externalUrl` lives on the URL step and the other
    // three on Details, so both steps are visited and the union is asserted to cover the
    // whole set — a new material field with no input here leaves `missing` non-empty.
    renderWithProviders(<ExternalSubmitForm edit={makeCtx()} />);
    await expect.element(page.getByTestId('apps-offsite-edit-url')).toBeInTheDocument();

    const found = new Map<string, boolean>();
    const sweep = () => {
      for (const field of MATERIAL_LISTING_PATCH_FIELDS) {
        const el = materialControl(field);
        if (el) found.set(field, el.disabled === true);
      }
    };
    sweep();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect.element(page.getByTestId('apps-offsite-edit-name')).toBeInTheDocument();
    sweep();

    const missing = MATERIAL_LISTING_PATCH_FIELDS.filter((f) => !found.has(f));
    expect(missing, 'material fields with no tagged input in the edit form').toEqual([]);
    const enabled = [...found.entries()].filter(([, disabled]) => !disabled).map(([f]) => f);
    expect(enabled, 'material fields the author can still type into').toEqual([]);
  });

  test('🔴 the locked inputs still SHOW their values — prefill is wider than the write', async () => {
    // The author has to be able to READ what a moderator approved; that is exactly the
    // information they need to decide whether to republish. This is the arm that fails if
    // the fix is "hide the fields" rather than "disable them".
    renderWithProviders(<ExternalSubmitForm edit={makeCtx()} />);
    await expect
      .element(page.getByTestId('apps-offsite-edit-url'))
      .toHaveValue('https://vitrine.civitai.com/');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect.element(page.getByTestId('apps-offsite-edit-name')).toHaveValue('Vitrine');
    await expect
      .element(page.getByTestId('apps-offsite-edit-source-repo'))
      .toHaveValue('https://github.com/civitai/vitrine');
  });

  test('🔴 the TRIVIAL fields stay editable and still save in place', async () => {
    // The control arm, and it is not optional: disabling the whole form satisfies every
    // assertion above while deleting the feature this state exists for — "unpublish, fix
    // your copy, republish". Tagline/description/category are not material, so the server
    // edits them IN PLACE on this status.
    renderWithProviders(<ExternalSubmitForm edit={makeCtx()} />);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('textbox', { name: /^Tagline/ }).fill('A better gallery');
    await page.getByTestId('apps-offsite-edit-save').click();

    await vi.waitFor(() => expect(mocks.updateListing).toHaveBeenCalledTimes(1));
    expect(mocks.updateListing).toHaveBeenCalledWith(
      expect.objectContaining({ listingId: 'apl_parent', patch: { tagline: 'A better gallery' } })
    );
    // No revision: a removed listing has no live copy to protect, so there is no shadow.
    expect(mocks.submitRevision).not.toHaveBeenCalled();
  });

  // 🔴 THE STATUS ARM, one CASE per status rather than one loop, so the scaffold's
  // auto-cleanup runs between renders (a manual `unmount()` fights it and blanks the next
  // container). Without these, the lock could be unconditional and every case above would
  // still pass while `draft` / `pending` / `approved` silently lost their edits.
  test.each(['draft', 'pending', 'approved'] as const)(
    '🔴 a %s listing leaves EVERY material field enabled and shows no lock notice',
    async (status) => {
      renderWithProviders(
        <ExternalSubmitForm
          edit={makeCtx({ status, shadowId: status === 'approved' ? 'shadow-1' : null })}
        />
      );
      await expect.element(page.getByTestId('apps-offsite-edit-url')).toBeInTheDocument();
      expect(materialControl('externalUrl')?.disabled, status).toBe(false);
      expect(
        page.getByTestId('apps-offsite-edit-material-locked-notice').elements(),
        status
      ).toHaveLength(0);
      await page.getByRole('button', { name: 'Next' }).click();
      await expect.element(page.getByTestId('apps-offsite-edit-name')).toBeInTheDocument();
      for (const field of ['name', 'contentRating', 'sourceRepoUrl'] as const) {
        expect(materialControl(field)?.disabled, `${status}/${field}`).toBe(false);
      }
    }
  );

  test('🔴 an ON-SITE unpublished listing is not told its "App URL" is locked', async () => {
    // It has no URL step and no external URL, so naming the field would describe something
    // that is not on screen. The three fields it DOES have are still named.
    renderWithProviders(<ExternalSubmitForm edit={makeCtx({ kind: 'onsite' })} />);
    const notice = page.getByTestId('apps-offsite-edit-material-locked-notice');
    await expect.element(notice).toBeInTheDocument();
    await expect.element(notice).not.toHaveTextContent(/App URL/);
    await expect.element(notice).toHaveTextContent(/source repository/i);
    // On-site opens straight on Details (no URL step), and the three fields are locked.
    await expect.element(page.getByTestId('apps-offsite-edit-name')).toBeInTheDocument();
    for (const field of ['name', 'contentRating', 'sourceRepoUrl'] as const) {
      expect(materialControl(field)?.disabled, field).toBe(true);
    }
    expect(materialControl('externalUrl'), 'no URL step for an on-site listing').toBeNull();
  });
});

describe('🔴 the OAuth scope disclosure follows the DRIFT, not the status', () => {
  const connect = {
    connectClientId: 'oauth-1',
    connectAllowedScopes: 12,
    connectRequestedScopes: 12,
    connectScopeJustifications: { ModelsWrite: 'original reason' },
  };

  test('🔴 while the masks AGREE, a justification edit stays live on an unpublished listing', async () => {
    // `buildScalarPatch` sends the (unchanged) mask alongside the edited justifications, and
    // `materialPatchChanges` counts the key as material only when the masks DIFFER — so this
    // save is trivial and the server takes it. Locking the box here would remove a
    // legitimate edit.
    renderWithProviders(<ExternalSubmitForm edit={makeCtx({ ...connect })} />);
    await page.getByRole('button', { name: 'Next' }).click();
    const justification = page.getByTestId('apps-offsite-justification-8');
    await expect.element(justification).toBeInTheDocument();
    await expect.element(justification).not.toBeDisabled();
  });

  test('🔴 once the mask has DRIFTED, the justifications lock and the notice says so', async () => {
    // A drifted mask rides along on EVERY patch, so even a tagline-only save is refused —
    // the same fillable-but-unsaveable defect one field further out. Same fixture, one
    // number different.
    renderWithProviders(
      <ExternalSubmitForm edit={makeCtx({ ...connect, connectAllowedScopes: 28 })} />
    );
    await expect
      .element(page.getByTestId('apps-offsite-edit-material-locked-notice'))
      .toHaveTextContent(/scopes have also changed/i);
    await page.getByRole('button', { name: 'Next' }).click();
    await expect.element(page.getByTestId('apps-offsite-justification-8')).toBeDisabled();
  });
});
