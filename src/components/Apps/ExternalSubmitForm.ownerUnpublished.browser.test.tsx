import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import {
  MATERIAL_LISTING_PATCH_FIELDS,
  type MaterialListingPatchField,
} from '~/shared/constants/app-capabilities.constants';
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
  const recording =
    (fn: (v: unknown) => void, result: unknown = {}) =>
    () => ({
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

/**
 * A notice's whole rendered text, whitespace-normalised.
 *
 * 🔴 `toHaveTextContent(string)` is a SUBSTRING match, so it cannot pin a whole message —
 * anything APPENDED to the notice still satisfies it. That is precisely the mutation shape
 * this file has to see (see `DRIFTED_NOTICE_TEXT`), so the drifted-state assertion compares
 * the normalised string with `toBe` instead. Read SYNCHRONOUSLY, so every call site must
 * already have awaited an assertion on the same element.
 */
function noticeText(testId: string): string {
  const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 🔴 THE WHOLE DRIFTED-STATE NOTICE, PINNED AS ONE STRING — and the cost is deliberate.
 *
 * The previous guard here asserted the ABSENCE of one substring (`/can be edited now/i`),
 * which is a guard on a WORD rather than on the message. It is walkable by REWORDING:
 * re-appending the old false promise as `' You may still edit the tagline, description and
 * category.'` says the same untrue thing, matches no part of that regex, and SURVIVED the
 * whole 14-case battery. Absence-of-a-phrase can only ever catch the one spelling somebody
 * already thought of.
 *
 * So this pins the entire normalised render instead. The trade is real and accepted: a
 * COSMETIC reword of this copy now fails this test and has to be re-pinned here. That is
 * the right exchange for a sentence that was factually wrong in production once already —
 * the notice tells an author whether their work can be saved, and a machine-readable claim
 * about it is worth a line of churn per reword.
 *
 * 🔴 IT IS A LITERAL, NOT `materialEditBlockedReason(ctx)`. Deriving the expectation from
 * the function under test would make this pass for any copy that function emits, which is
 * half of what has to be pinned — the original defect lived in the JSX, APPENDING to a
 * return value that was itself correct.
 *
 * The leading duplication is the Mantine Alert TITLE running into the body in
 * `textContent`; they are separate elements on screen. Spelled out via `ALERT_TITLE` so it
 * reads as structure rather than as a copy defect.
 */
const ALERT_TITLE = 'This app is unpublished';
const DRIFTED_NOTICE_TEXT =
  ALERT_TITLE +
  `This app is unpublished, so its name, App URL, source repository and content rating ` +
  `are locked — and your OAuth app's permissions have changed since this listing was last ` +
  `reviewed. That changed permission set rides along on every save, so while the app stays ` +
  `unpublished NOTHING on this screen can be saved — not the tagline, description or ` +
  `category either. To edit anything, ask the app's owner to republish it; the new ` +
  `permissions are then reviewed along with your changes.`;

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
    // On-site opens straight on Details (no URL step), and every field it HAS is locked.
    await expect.element(page.getByTestId('apps-offsite-edit-name')).toBeInTheDocument();

    // 🔴 DERIVED FROM THE SERVER'S CONSTANT, NOT HAND-LISTED. This used to spell
    // `['name', 'contentRating', 'sourceRepoUrl']` — three of the four members of
    // `MATERIAL_LISTING_PATCH_FIELDS` — which is a LEDGER THAT CANNOT GROW: a fifth
    // material field added server-side would be refused by `updateListing` and would render
    // an ENABLED input here, and this test would stay green because the literal never
    // mentioned it. The off-site arm above already walks the constant; this arm is now the
    // same sweep minus the ONE field on-site genuinely does not have.
    //
    // `externalUrl` is excluded by NAME rather than by "whatever is missing", so the
    // exclusion is a claim that can itself be wrong and be caught — the assertion below
    // pins that it really is absent.
    const onsiteMaterialFields = MATERIAL_LISTING_PATCH_FIELDS.filter(
      (f): f is Exclude<MaterialListingPatchField, 'externalUrl'> => f !== 'externalUrl'
    );
    // Positive control: the filter must leave a NON-EMPTY set. A rename of the excluded
    // member (or of any other) that emptied this list would otherwise make the loop below
    // vacuous and green.
    expect(onsiteMaterialFields.length).toBeGreaterThan(0);
    for (const field of onsiteMaterialFields) {
      expect(materialControl(field)?.disabled, field).toBe(true);
    }
    expect(materialControl('externalUrl'), 'no URL step for an on-site listing').toBeNull();
  });
});

/**
 * 🔴 THE ASSETS STEP — NEWLY REACHABLE, EAGERLY WRITING, AND IT SHIPPED WITH NO FRAME.
 *
 * `ListingMediaEditor` got a careful repair-state frame. This step got none, and for an
 * OFF-SITE listing it is the ONLY image surface there is:
 * `capabilitiesForKind('offsite').listingMedia` is `false`, so `editorTabsFor` withholds
 * the Media tab entirely and `ListingMediaEditor` never mounts for these listings. The
 * frame that was added therefore covered the case that did NOT need it most.
 *
 * The write semantics are the part that must be stated. `ListingAssetStep` writes EAGERLY,
 * one mutation per change, against `edit.parentId` — a non-approved listing has no shadow,
 * so nothing is staged, nothing waits for Save, and leaving the page does not undo it. That
 * differs BOTH from the approved case (which stages a revision) and from the scalar fields
 * on the previous step of this very wizard (which do wait for Save). An author who assumes
 * either is wrong in a way that costs them their live imagery.
 */
describe('🔴 the ASSETS step carries the repair frame too', () => {
  async function openAssets() {
    // URL step -> Details -> Assets. Two `Next` clicks for an off-site listing.
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
  }

  test('🔴 an unpublished listing is told these image writes are IMMEDIATE, not staged', async () => {
    renderWithProviders(<ExternalSubmitForm edit={makeCtx()} />);
    await openAssets();

    const notice = page.getByTestId('apps-offsite-edit-assets-unpublished-notice');
    await expect.element(notice).toBeInTheDocument();
    // The app is DOWN…
    await expect.element(notice).toHaveTextContent(/not visible in the store/i);
    // …and the surprising half: these writes do NOT wait for Save and are NOT staged.
    await expect.element(notice).toHaveTextContent(/immediately/i);
    await expect.element(notice).toHaveTextContent(/not.*staged/i);
  });

  test('🔴 CONTROL — a PUBLISHED listing gets NO such frame', async () => {
    // Without this the notice could be unconditional, and every assertion above would pass
    // while every approved author was told their staged edits apply immediately — the exact
    // inversion of the truth, and a worse defect than the one being fixed.
    renderWithProviders(<ExternalSubmitForm edit={makeCtx({ status: 'approved' })} />);
    await openAssets();

    await expect.element(page.getByTestId('apps-offsite-wizard-assets-panel')).toBeInTheDocument();
    expect(page.getByTestId('apps-offsite-edit-assets-unpublished-notice').elements()).toHaveLength(
      0
    );
  });

  test('🔴 it is ROLE-AWARE, like every other repair-state sentence', async () => {
    renderWithProviders(<ExternalSubmitForm edit={makeCtx({ role: 'editor' })} />);
    await openAssets();

    const notice = page.getByTestId('apps-offsite-edit-assets-unpublished-notice');
    await expect.element(notice).toHaveTextContent(/its owner unpublished it/i);
    await expect.element(notice).not.toHaveTextContent(/you unpublished it/i);
  });

  /**
   * 🔴 THE OWNER ARM — the other direction of the same branch, and without it the branch is
   * not covered at all.
   *
   * The editor case above and the default fixture BOTH land on the non-owner arm
   * (`makeCtx()` carries no `role`, and `isOwnerEdit` fails safe to `false`), so replacing
   * `isOwnerEdit(edit)` in `ExternalListingEditForm.tsx` with a bare `false` changes nothing
   * either of them can see and SURVIVED all 14 cases. A branch only one side of which is
   * ever exercised is a constant with extra steps.
   *
   * This is the same pair `ListingMediaEditor` already keeps
   * (`src/tests/pages/apps/listing-media-page.browser.test.tsx`), and it is kept for the
   * same reason stated there: a mutant that emits ONE role's copy for everybody passes every
   * assertion on the other side. Run the two as a pair.
   *
   * The two attributions are mutually exclusive by construction — "you unpublished it" and
   * "its owner unpublished it" cannot both be true of one reader — so each arm asserts the
   * presence of its own and the ABSENCE of the other's. The role-independent half ("not
   * visible in the store") is asserted on both, so collapsing the branch into an empty
   * string cannot pass either.
   */
  test('🔴 the OWNER gets the owner attribution — the branch is not a blanket reword', async () => {
    renderWithProviders(<ExternalSubmitForm edit={makeCtx({ role: 'owner' })} />);
    await openAssets();

    const notice = page.getByTestId('apps-offsite-edit-assets-unpublished-notice');
    await expect.element(notice).toBeInTheDocument();
    // Role-independent, and true on both arms — so this cannot be what carries the case.
    await expect.element(notice).toHaveTextContent(/not visible in the store/i);
    // The owner's own attribution…
    await expect.element(notice).toHaveTextContent(/you unpublished it/i);
    // …and NOT the editor's, which would be false for the person who did it.
    await expect.element(notice).not.toHaveTextContent(/its owner unpublished it/i);
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
    // 🔴 THE ASSERTION CHANGED WITH THE COPY, AND THE OLD ONE WAS THE BUG. It matched
    // /scopes have also changed/i — a sentence appended after "Tagline, description and
    // category can be edited now", i.e. the test pinned HALF of a self-contradicting
    // message and was satisfied. The notice now states the actual consequence.
    const notice = page.getByTestId('apps-offsite-edit-material-locked-notice');
    await expect.element(notice).toHaveTextContent(/nothing on this screen can be saved/i);
    // 🔴 AND THE WHOLE RENDERED MESSAGE IS PINNED, not merely the function's return value.
    // This is not redundant with the unit test of `materialEditBlockedReason`'s output: the
    // contradiction originally lived in the JSX, as a `{scopeLocked ? '…' : ''}` APPENDED
    // after the reason. A mutant that re-adds any such append is invisible to a unit test of
    // the copy function — the function's return is still correct — and invisible to a
    // presence-only assertion here, because appending does not disturb text already matched.
    //
    // 🔴 IT IS ALSO NOT AN ABSENCE ASSERTION ANY MORE, and that is the point of this round.
    // The previous line here was `.not.toHaveTextContent(/can be edited now/i)`, which pins
    // one SPELLING of the false promise. Re-appending the exact old sentence died; appending
    // a reworded equivalent ("You may still edit the tagline, description and category.")
    // said the same untrue thing and SURVIVED all 14 cases. Equality over the normalised
    // string cannot be walked that way — any append, in any wording, moves it.
    // The awaited assertion above has already settled this element, so the synchronous read
    // is safe here.
    expect(noticeText('apps-offsite-edit-material-locked-notice')).toBe(DRIFTED_NOTICE_TEXT);
    await page.getByRole('button', { name: 'Next' }).click();
    await expect.element(page.getByTestId('apps-offsite-justification-8')).toBeDisabled();
  });

  /**
   * 🔴 THE MISSING HALF: ATTEMPT THE SAVE.
   *
   * The test above asserts the box is DISABLED and stops there — which is precisely why the
   * dead end was invisible. A disabled input is only half the story; the question an author
   * has is "can I save anything from this screen", and nothing ever asked it.
   *
   * The answer is no, and by a route that is easy to miss: `handleSave` runs
   * `scopeJustificationError(values)` for ANY connect listing (gated on
   * `edit.connectClientId != null`, NOT on `scopeLocked`). The drifted mask adds a sensitive
   * scope with no prefilled justification, so the save aborts CLIENT-side, sets the scope
   * error and jumps the author to Details — where the box that would clear it is disabled.
   *
   * So this drives the real click path: edit a NON-material field the copy used to promise
   * was saveable (tagline), press Save, and assert it did not go through.
   *
   * 🟡 LABEL: THIS IS A CHARACTERISATION GUARD, NOT REGRESSION COVERAGE, and it is measured
   * rather than assumed — restoring `offsiteEditConfig.ts` + `ExternalListingEditForm.tsx`
   * to b16cc80c2c and re-running leaves this test GREEN (11 executed, only the copy test
   * red). That is the correct result and the reason the finding was worded as "the copy
   * claims the opposite": the dead end is PRE-EXISTING and this PR does not remove it. The
   * fix is that the copy stops denying it.
   *
   * What this test is FOR, then, is the next change rather than this one. The dead end has
   * two independent halves — the unconditional scope check in `handleSave` and the disabled
   * boxes — and a plausible future "fix" addresses one and leaves the other, which would
   * still be a dead end while looking repaired. Both halves are asserted here, so a half-fix
   * reddens exactly one line.
   */
  test('🟡 in the DRIFTED state a tagline-only Save is REFUSED — the screen is a dead end', async () => {
    const onDrift = makeCtx({
      ...connect,
      // Stored mask is 12 (= ModelsRead 4 | ModelsWrite 8), with ModelsWrite justified.
      // The client now allows 24 (= ModelsWrite 8 | ModelsDelete 16). ModelsDelete is
      // SENSITIVE and has NO stored rationale — the client did not have it when the listing
      // was last reviewed — and `editContextToForm` cannot invent one. That is what makes
      // the save unclearable rather than merely inconvenient.
      connectAllowedScopes: 24,
    });
    renderWithProviders(<ExternalSubmitForm edit={onDrift} />);

    await page.getByRole('button', { name: 'Next' }).click();

    // Edit the tagline — the field the old copy explicitly said "can be edited now".
    const tagline = page.getByRole('textbox', { name: 'Tagline' });
    await expect.element(tagline).toBeInTheDocument();
    // 🔴 NOT disabled. The tagline is genuinely editable, which is exactly what made the old
    // copy plausible — the defect is that editing it achieves nothing.
    await expect.element(tagline).not.toBeDisabled();
    await tagline.fill('A brand new tagline');

    await page.getByTestId('apps-offsite-edit-save').click();

    // 🔴 THE SAVE DID NOT LAND, asserted on the MUTATION SPY rather than on the absence of a
    // success toast: a missing toast is indistinguishable from one that has not rendered
    // yet, whereas "the mutation was never called" is a positive statement about the path.
    expect(mocks.updateListing).not.toHaveBeenCalled();

    // 🔴 AND THE DEAD END IS NOW ON SCREEN IN ONE FRAME: the unjustified sensitive scope
    // (ModelsDelete, bit 16) carries a REQUIRED error, and the same input is DISABLED. An
    // error on a box the author cannot type in is the whole defect, stated as an assertion.
    const blocked = page.getByTestId('apps-offsite-justification-16');
    await expect.element(blocked).toBeDisabled();
    await expect.element(blocked).toHaveAccessibleDescription(/justification is required/i);
  });
});
