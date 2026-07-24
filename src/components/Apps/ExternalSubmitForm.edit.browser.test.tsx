import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { ListingEditContext } from './offsiteEditConfig';

/**
 * W13 — `/apps/submit?edit=` EDIT mode of the External wizard (dual-mode
 * `ExternalSubmitForm`). Browser-mode surface test: prefills fields + existing
 * assets; a DRAFT edit applies IN PLACE (updateListing on the listing's own id, no
 * revision submit); an APPROVED edit targets the SERVER-resolved SHADOW for the
 * scalar write (updateRevisionDraft) + submits it (submitListingRevision), shows the
 * approved-notice; slug is read-only; the OG auto-pull re-fire is non-destructive.
 *
 * 🔴 REGRESSION GUARD (audit #3010): removing a prefilled screenshot while editing
 * an APPROVED listing must target the SHADOW's row id (the id `getMyListingForEdit`
 * returns — it resolves the shadow server-side), NEVER the live parent's row —
 * otherwise the delete hits the served listing, bypassing review. The service test
 * `offsite-listing.edit-consolidate.service.test.ts` proves the server returns
 * shadow-owned rows; this proves the client removes by exactly that row id.
 */

const mocks = vi.hoisted(() => ({
  meta: { data: undefined as unknown, isFetching: false, isSuccess: false },
  updateListing: vi.fn(),
  updateRevision: vi.fn(),
  submitRevision: vi.fn(),
  removeScreenshot: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('~/utils/trpc', () => {
  const noopMutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  const recording = (fn: (v: unknown) => void, result: unknown = {}) => () => ({
    mutate: vi.fn(),
    mutateAsync: (vars: unknown) => {
      fn(vars);
      return Promise.resolve(result);
    },
    isPending: false,
  });
  return {
    setTrpcBatchingEnabled: vi.fn(),
    trpc: {
      useUtils: () => ({
        appListings: {
          listMySubmissions: { invalidate: mocks.invalidate },
          getMyListingForEdit: { invalidate: mocks.invalidate },
        },
      }),
      appListings: {
        fetchListingMetaFromUrl: { useQuery: () => mocks.meta },
        updateListing: { useMutation: recording(mocks.updateListing) },
        updateRevisionDraft: { useMutation: recording(mocks.updateRevision) },
        submitListingRevision: { useMutation: recording(mocks.submitRevision) },
        removeScreenshot: { useMutation: recording(mocks.removeScreenshot) },
        // ListingAssetStep procs not otherwise exercised.
        persistAssetImage: { useMutation: noopMutation },
        ingestAssetFromUrl: { useMutation: noopMutation },
        setIcon: { useMutation: noopMutation },
        setCover: { useMutation: noopMutation },
        addScreenshot: { useMutation: noopMutation },
      },
    },
  };
});

vi.mock('~/hooks/useCFImageUpload', () => ({
  useCFImageUpload: () => ({ uploadToCF: vi.fn(), files: [], resetFiles: vi.fn(), removeImage: vi.fn() }),
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
    status: 'draft',
    hasPendingRevision: false,
    shadowId: null,
    scalars: {
      name: 'Vitrine',
      tagline: 'A gallery',
      description: 'desc',
      category: 'utility',
      contentRating: 'g',
      externalUrl: 'https://vitrine.civitai.com/',
    },
    assets: {
      icon: { imageId: 10, url: 'https://cdn/icon.png' },
      cover: { imageId: 20, url: 'https://cdn/cover.png' },
      screenshots: [{ id: 'ss_row', imageId: 30, url: 'https://cdn/s1.png', caption: null, order: 0 }],
    },
    ...overrides,
  };
}

/**
 * An APPROVED edit context as `getMyListingForEdit` returns it: `shadowId` is set
 * and every asset row id is the SHADOW's copy (server-resolved). `shadow-ss-1` is
 * the SHADOW screenshot row — a removal must target it, not any parent row.
 */
function makeApprovedCtx(overrides: Partial<ListingEditContext> = {}): ListingEditContext {
  return makeCtx({
    status: 'approved',
    shadowId: 'shadow-1',
    assets: {
      icon: { imageId: 11, url: 'https://cdn/shadow-icon.png' },
      cover: { imageId: 21, url: 'https://cdn/shadow-cover.png' },
      screenshots: [
        { id: 'shadow-ss-1', imageId: 31, url: 'https://cdn/shadow-s1.png', caption: null, order: 0 },
      ],
    },
    ...overrides,
  });
}

beforeEach(() => {
  mocks.meta = { data: undefined, isFetching: false, isSuccess: false };
  mocks.updateListing.mockClear();
  mocks.updateRevision.mockClear();
  mocks.submitRevision.mockClear();
  mocks.removeScreenshot.mockClear();
  mocks.invalidate.mockClear();
});

describe('ExternalSubmitForm — edit mode', () => {
  test('prefills the URL and (on Details) the name; slug is read-only', async () => {
    renderWithProviders(<ExternalSubmitForm edit={makeCtx()} />);
    await expect
      .element(page.getByTestId('apps-offsite-edit-url'))
      .toHaveValue('https://vitrine.civitai.com/');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect.element(page.getByRole('textbox', { name: /^Name/ })).toHaveValue('Vitrine');
    const slug = page.getByTestId('apps-offsite-edit-slug');
    await expect.element(slug).toHaveValue('vitrine');
    expect(slug.element().hasAttribute('readonly')).toBe(true);
  });

  test('shows the existing icon + cover previews on the Assets step', async () => {
    renderWithProviders(<ExternalSubmitForm edit={makeCtx()} />);
    // URL → Details → Assets.
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect
      .element(page.getByTestId('apps-offsite-current-icon-preview'))
      .toBeInTheDocument();
    await expect
      .element(page.getByTestId('apps-offsite-current-cover-preview'))
      .toBeInTheDocument();
  });

  test('a DRAFT edit saves IN PLACE (updateListing on the listing id, no revision submit)', async () => {
    renderWithProviders(<ExternalSubmitForm edit={makeCtx({ status: 'draft' })} />);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('textbox', { name: /^Name/ }).fill('Vitrine Renamed');
    await page.getByTestId('apps-offsite-edit-save').click();

    await vi.waitFor(() => expect(mocks.updateListing).toHaveBeenCalledTimes(1));
    expect(mocks.updateListing).toHaveBeenCalledWith(
      expect.objectContaining({ listingId: 'apl_parent', patch: { name: 'Vitrine Renamed' } })
    );
    // No revision for a draft in-place edit.
    expect(mocks.submitRevision).not.toHaveBeenCalled();
  });

  test('an APPROVED edit writes the scalar patch to the SHADOW and submits the revision', async () => {
    renderWithProviders(<ExternalSubmitForm edit={makeApprovedCtx()} />);
    // The approved-notice renders.
    await expect
      .element(page.getByTestId('apps-offsite-edit-approved-notice'))
      .toBeInTheDocument();

    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('textbox', { name: /^Name/ }).fill('Vitrine Live Edit');
    await page.getByTestId('apps-offsite-edit-save').click();

    await vi.waitFor(() => expect(mocks.submitRevision).toHaveBeenCalledWith({ shadowId: 'shadow-1' }));
    // The scalar patch targeted the SHADOW, not the live parent (no updateListing).
    expect(mocks.updateRevision).toHaveBeenCalledWith(
      expect.objectContaining({ shadowId: 'shadow-1', patch: { name: 'Vitrine Live Edit' } })
    );
    expect(mocks.updateListing).not.toHaveBeenCalled();
  });

  test('🔴 removing a prefilled screenshot on an APPROVED edit targets the SHADOW row id (not the parent)', async () => {
    renderWithProviders(<ExternalSubmitForm edit={makeApprovedCtx()} />);
    // URL → Details → Assets.
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    // The prefilled shadow screenshot renders with a Remove control.
    await page.getByTestId('apps-offsite-screenshot-remove-0').click();
    await vi.waitFor(() => expect(mocks.removeScreenshot).toHaveBeenCalledTimes(1));
    // Removal MUST key off the SHADOW's row id — never a live parent row.
    expect(mocks.removeScreenshot).toHaveBeenCalledWith({ screenshotId: 'shadow-ss-1' });
  });

  test('shows the derived scopes READ-ONLY + editable SENSITIVE justifications and saves the scope patch', async () => {
    // A connect listing: the client allows ModelsRead(4)|ModelsWrite(8) = 12.
    // ModelsWrite is SENSITIVE (gets a required input); ModelsRead is not (collapsed).
    const ctx = makeCtx({
      status: 'draft',
      connectClientId: 'oauth-1',
      connectAllowedScopes: 12,
      connectRequestedScopes: 12,
      connectScopeJustifications: { ModelsWrite: 'original reason' },
    });
    renderWithProviders(<ExternalSubmitForm edit={ctx} />);
    // URL → Details (the scope disclosure lives on Details).
    await page.getByRole('button', { name: 'Next' }).click();
    await expect.element(page.getByTestId('apps-offsite-scope-readonly')).toBeInTheDocument();
    expect(page.getByTestId('sensitive-scope-badge').elements().length).toBeGreaterThan(0);
    // The non-sensitive ModelsRead(4) has NO justification input (it's collapsed).
    expect(page.getByTestId('apps-offsite-justification-4').elements()).toHaveLength(0);

    // Edit the ModelsWrite (bit 8) SENSITIVE justification, then save.
    await page.getByTestId('apps-offsite-justification-8').fill('updated reason');
    await page.getByTestId('apps-offsite-edit-save').click();

    await vi.waitFor(() => expect(mocks.updateListing).toHaveBeenCalledTimes(1));
    expect(mocks.updateListing).toHaveBeenCalledWith(
      expect.objectContaining({
        listingId: 'apl_parent',
        patch: expect.objectContaining({
          requestedScopes: 12,
          scopeJustifications: { ModelsWrite: 'updated reason' },
        }),
      })
    );
    // A justification-only edit on a DRAFT is in-place — no revision.
    expect(mocks.submitRevision).not.toHaveBeenCalled();
  });

  test('a SENSITIVE justification is REQUIRED on save — an empty one blocks the save', async () => {
    // UserRead(1) is sensitive; the prefill has no justification for it.
    const ctx = makeCtx({
      status: 'draft',
      connectClientId: 'oauth-1',
      connectAllowedScopes: 1,
      connectRequestedScopes: 1,
      connectScopeJustifications: {},
    });
    renderWithProviders(<ExternalSubmitForm edit={ctx} />);
    await page.getByRole('button', { name: 'Next' }).click();
    // Change the name so there IS a scalar change to save.
    await page.getByRole('textbox', { name: /^Name/ }).fill('Renamed');
    await page.getByTestId('apps-offsite-edit-save').click();
    // Save is blocked — no mutation fires — and the required error is surfaced.
    await expect
      .element(page.getByText('A justification is required for this permission.'))
      .toBeInTheDocument();
    expect(mocks.updateListing).not.toHaveBeenCalled();
    // Filling the justification unblocks the save.
    await page.getByTestId('apps-offsite-justification-1').fill('needed to greet the user');
    await page.getByTestId('apps-offsite-edit-save').click();
    await vi.waitFor(() => expect(mocks.updateListing).toHaveBeenCalledTimes(1));
  });

  test('an existing listing with a BLANK App URL is grandfathered — prompts but does not block', async () => {
    const ctx = makeCtx({
      status: 'draft',
      scalars: {
        name: 'Vitrine',
        tagline: null,
        description: null,
        category: null,
        contentRating: 'g',
        externalUrl: '', // pre-existing blank URL
      },
    });
    renderWithProviders(<ExternalSubmitForm edit={ctx} />);
    // The URL step prompts to add one (does NOT hard-block).
    await expect.element(page.getByTestId('apps-offsite-edit-url-prompt')).toBeInTheDocument();
    // Advancing is allowed despite the blank URL.
    await page.getByTestId('apps-offsite-wizard-next-url').click();
    await page.getByRole('textbox', { name: /^Name/ }).fill('Vitrine Renamed');
    await page.getByTestId('apps-offsite-edit-save').click();
    await vi.waitFor(() => expect(mocks.updateListing).toHaveBeenCalledTimes(1));
    expect(mocks.updateListing).toHaveBeenCalledWith(
      expect.objectContaining({ listingId: 'apl_parent', patch: { name: 'Vitrine Renamed' } })
    );
  });

  test('a listing with no connect client shows no scope section', async () => {
    renderWithProviders(<ExternalSubmitForm edit={makeCtx({ connectClientId: null })} />);
    await page.getByRole('button', { name: 'Next' }).click();
    expect(page.getByTestId('apps-offsite-scope-disclosure').elements()).toHaveLength(0);
  });

  test('the OG auto-pull re-fire is non-destructive (a prefilled name is not clobbered)', async () => {
    // Simulate the auto-pull returning a different name suggestion.
    mocks.meta = {
      data: { name: 'Some OG Title', tagline: '', coverImageUrl: undefined, iconImageUrl: undefined },
      isFetching: false,
      isSuccess: true,
    };
    renderWithProviders(<ExternalSubmitForm edit={makeCtx()} />);
    // Re-advance the URL (fires the auto-pull) then check Details.
    await page.getByRole('button', { name: 'Next' }).click();
    // Name stays the prefilled value — the OG suggestion only fills a BLANK name.
    await expect.element(page.getByRole('textbox', { name: /^Name/ })).toHaveValue('Vitrine');
  });
});
