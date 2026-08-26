import {
  Alert,
  Button,
  Group,
  Loader,
  Select,
  Stack,
  Stepper,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconApps,
  IconDeviceFloppy,
  IconExternalLink,
  IconInfoCircle,
  IconLock,
  IconSparkles,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  OFFSITE_CATEGORY_OPTIONS,
  OFFSITE_CONTENT_RATING_OPTIONS,
  OFFSITE_SUBMIT_LIMITS,
  isUrlStepComplete,
  scopeJustificationError,
  validateOffsiteSubmitForm,
  SOURCE_REPO_HOSTS_LABEL,
  type OffsiteSubmitFormErrors,
  type OffsiteSubmitFormValues,
} from '~/components/Apps/offsiteSubmitFormConfig';
import { DerivedScopesDisclosure } from '~/components/Apps/DerivedScopesDisclosure';
import { FadeIn } from '~/components/Apps/wizardMotion';
import { ListingAssetStep } from '~/components/Apps/ListingAssetStep';
import { describeMissingChannels } from '~/components/Apps/listingAutofillStatus';
import { useListingAutofill } from '~/components/Apps/useListingAutofill';
import {
  buildScalarPatch,
  editContextToForm,
  isOnsiteEdit,
  hasScalarChanges,
  isApprovedEdit,
  isOwnerEdit,
  listingEditHeaderCopy,
  materialEditBlockedReason,
  scopeDisclosureLockedForEdit,
  type ListingEditContext,
} from '~/components/Apps/offsiteEditConfig';
import type { MarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';
import type { OffsiteContentRating } from '~/server/schema/blocks/offsite-listing.schema';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * /apps/submit?edit=<listingId> — the EDIT wizard (W13). Reuses the create wizard's
 * URL/Details/Assets shape against an EXISTING listing. The "effective target" the
 * detail + asset edits write to depends on the live status:
 *
 *   - draft / pending  → the listing's OWN id. Detail edits (`updateListing`) +
 *     asset edits apply IN PLACE; the existing pending request keeps reviewing the
 *     updated row (no re-submit).
 *   - approved         → a SHADOW revision id. On entering edit we `beginListingRevision`
 *     (idempotent — reuses an in-flight shadow) to get the shadow id; ALL detail +
 *     asset edits target the shadow; the live version stays serving until a mod
 *     re-approves. Save writes the scalar patch to the shadow (`updateRevisionDraft`)
 *     then `submitListingRevision`.
 *
 * Assets mutate EAGERLY (each set/add/remove hits the server immediately, like the
 * create wizard) against the effective target, so the primary action mainly commits
 * the scalar patch (+ submits the revision for an approved edit). SLUG is immutable
 * (read-only); URL is editable (a material change on an approved listing → shadow).
 * The OG auto-pull re-fires on a URL change (non-destructive — only refreshes blank
 * fields / asset suggestions). DARK behind `app-blocks-author`.
 */

const STEP_URL = 0;

export function ExternalListingEditForm({ edit }: { edit: ListingEditContext }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const approved = isApprovedEdit(edit);

  /**
   * 🔴 KIND-AWARE WIZARD SHAPE. An ON-SITE listing has no App URL and no OAuth-connect
   * client, so it gets neither the URL step nor the scope disclosure — both are off-site
   * concepts, and offering them to an on-site owner invites an edit the model has no
   * field for (`buildScalarPatch` refuses to emit `externalUrl` for this kind, so the
   * step would also be inert).
   *
   * The step INDICES are derived rather than constant, because dropping a `Stepper.Step`
   * renumbers the ones after it — a fixed `STEP_DETAILS = 1` would silently point at
   * Assets on an on-site listing. Off-site keeps 0/1/2 exactly as before.
   */
  const showUrlStep = !isOnsiteEdit(edit);
  // 🔴 The HEADER reads the SAME flag the wizard shape does — see `listingEditHeaderCopy`.
  const headerCopy = listingEditHeaderCopy(showUrlStep);

  /**
   * 🔴 THE REPAIR-STATE LOCK. Non-null while this listing is UNPUBLISHED, in which case the
   * server refuses any MATERIAL change with `MATERIAL_CHANGE_BLOCKED` — see
   * `materialEditBlockedReason` and `updateListing`'s `removed` branch. Every input this
   * gates is one the author could otherwise fill and never save.
   *
   * 🔴 THE VALUE IS THE GUARD *AND* THE COPY, deliberately one expression rather than a
   * boolean beside a string. A separate `materialBlocked` flag is how the inputs get
   * disabled with no explanation on screen, or explained while still enabled.
   */
  const materialBlockedReason = materialEditBlockedReason(edit);
  const materialBlocked = materialBlockedReason != null;
  // See `scopeDisclosureLockedForEdit`: a DRIFTED scope mask makes every save material, so
  // the justification boxes are unsaveable too and must not stay live. Not implied by
  // `materialBlocked` — while the masks agree, a justification edit is trivial and saves.
  const scopeLocked = scopeDisclosureLockedForEdit(edit);
  const STEP_DETAILS = showUrlStep ? 1 : 0;
  const STEP_ASSETS = showUrlStep ? 2 : 1;

  const [active, setActive] = useState<number>(showUrlStep ? STEP_URL : STEP_DETAILS);
  const [values, setValues] = useState<OffsiteSubmitFormValues>(() => editContextToForm(edit));
  // Latest `values` for the OG-apply effect's emptiness check (the effect must read
  // current emptiness WITHOUT depending on `values`, and the async `setValues` updater
  // hasn't run yet when we compute the button's feedback — same reason the create
  // wizard computes off `data`).
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const [errors, setErrors] = useState<OffsiteSubmitFormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [assetsDirty, setAssetsDirty] = useState(false);
  // Reveal the required error on every empty SENSITIVE justification after a blocked
  // save (mirrors the create wizard's sensitive-only justification model).
  const [showScopeErrors, setShowScopeErrors] = useState(false);

  // Effective asset/detail target. draft/pending → the listing itself; approved →
  // the SHADOW revision. 🔴 The shadow is resolved SERVER-SIDE by `getMyListingForEdit`
  // (it begins the revision and returns `shadowId` + the SHADOW's asset rows in
  // `edit.assets`), so every asset row id the UI can mutate is a shadow row — never
  // the live parent's. There is deliberately NO client-side "begin on mount": that
  // left a window where the FIRST edit of an approved listing seeded parent row ids
  // and a screenshot removal deleted from the live served listing.
  const shadowId = edit.shadowId;
  const effectiveId = approved ? shadowId : edit.parentId;

  // OG metadata auto-pull via the shared `useListingAutofill` hook (same SSRF-safe path
  // as create) — auto-fires on a URL CHANGE (blur/Enter/advance + a debounced pause);
  // NON-DESTRUCTIVE (fills only blank name/tagline/description; an icon/cover suggestion
  // is only ACTIONABLE for an EMPTY slot, so a prefilled asset is never clobbered).
  // Seeded with the prefilled URL so it does NOT auto-fire on mount for an existing
  // listing — only a change (or the assets-step "Re-pull from site" button) fires.
  const autofill = useListingAutofill({
    externalUrl: values.externalUrl,
    setValues,
    valuesRef,
    onBeforeFire: (url) => setField('externalUrl', url),
    initialUrl: edit.scalars.externalUrl ?? undefined,
    // A suggestion is only actionable for a slot the prefill left EMPTY (imageId == null
    // — the only case where ListingAssetStep renders a "Use this"), so the note never
    // claims "applied" for an already-filled slot.
    isSuggestionActionable: (kind) => edit.assets[kind].imageId == null,
  });

  const updateListingMutation = trpc.appListings.updateListing.useMutation();
  const updateRevisionMutation = trpc.appListings.updateRevisionDraft.useMutation();
  const submitRevisionMutation = trpc.appListings.submitListingRevision.useMutation();

  const saving =
    updateListingMutation.isPending ||
    updateRevisionMutation.isPending ||
    submitRevisionMutation.isPending;

  function setField<K extends keyof OffsiteSubmitFormValues>(
    key: K,
    value: OffsiteSubmitFormValues[K]
  ) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function handleJustificationChange(key: string, text: string) {
    setValues((v) => ({
      ...v,
      scopeJustifications: { ...v.scopeJustifications, [key]: text },
    }));
  }

  function handleUrlBlur() {
    // A blank URL is GRANDFATHERED on an existing listing — leave it be (no error).
    if (values.externalUrl.trim().length === 0) {
      setErrors((prev) => ({ ...prev, externalUrl: undefined }));
      return;
    }
    // Canonicalise + auto-fire the OG pull (once per distinct URL) via the hook.
    const { error } = autofill.triggerFromUrl(values.externalUrl);
    if (error) return; // a bad URL keeps whatever's typed (no hard error on blur here)
    setErrors((prev) => ({ ...prev, externalUrl: undefined }));
  }

  function handleAdvanceFromUrl() {
    // GRANDFATHER: a pre-existing listing may have no App URL. Don't force-fill or
    // block — advance and let the inline prompt nudge the author to add one. (Create
    // requires it; an existing blank does not hard-block an edit.)
    if (values.externalUrl.trim().length === 0) {
      setErrors((prev) => ({ ...prev, externalUrl: undefined }));
      setActive(STEP_DETAILS);
      return;
    }
    const { error } = autofill.triggerFromUrl(values.externalUrl);
    if (error) {
      setErrors((prev) => ({ ...prev, externalUrl: error }));
      return;
    }
    setErrors((prev) => ({ ...prev, externalUrl: undefined }));
    setActive(STEP_DETAILS);
  }

  function handleUrlKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    handleAdvanceFromUrl();
  }

  async function finishSave() {
    await Promise.all([
      utils.appListings.listMySubmissions.invalidate(),
      utils.appListings.getMyListingForEdit.invalidate({ listingId: edit.parentId }),
    ]);
    showSuccessNotification({
      title: 'Saved',
      message: approved
        ? 'Sent for review — your current version stays live until a moderator re-approves.'
        : 'Your changes are saved.',
    });
    void router.push('/apps/mine');
  }

  async function handleSave() {
    setServerError(null);
    // Client mirror of the server validation (URL/name/slug/bounds) before the
    // round-trip; the server stays the source of truth.
    const nextErrors = validateOffsiteSubmitForm(values);
    // SENSITIVE-only justification model (parity with create): every sensitive scope
    // needs a bounded, non-empty rationale before save. Non-sensitive scopes are
    // read-only + never required. No connect client → no scopes → nothing to check.
    if (edit.connectClientId != null) {
      const scopeError = scopeJustificationError(values);
      if (scopeError) nextErrors.scopeJustifications = scopeError;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      // Steer the author to the step that carries the first error.
      // An on-site listing has no URL step to send them back to (and no URL error).
      if (nextErrors.externalUrl && showUrlStep) setActive(STEP_URL);
      else {
        if (nextErrors.scopeJustifications) setShowScopeErrors(true);
        setActive(STEP_DETAILS);
      }
      return;
    }
    setShowScopeErrors(false);

    const patch = buildScalarPatch(edit, values);
    const scalarChanged = hasScalarChanges(patch);

    try {
      if (approved) {
        if (!shadowId) {
          setServerError('Preparing the revision — try again in a moment.');
          return;
        }
        if (!scalarChanged && !assetsDirty) {
          // Nothing to review — just return to the list.
          showSuccessNotification({ title: 'No changes', message: 'Nothing to submit for review.' });
          void router.push('/apps/mine');
          return;
        }
        if (scalarChanged) {
          await updateRevisionMutation.mutateAsync({ shadowId, patch });
        }
        await submitRevisionMutation.mutateAsync({ shadowId });
      } else {
        if (scalarChanged) {
          await updateListingMutation.mutateAsync({ listingId: edit.parentId, patch });
        }
      }
      await finishSave();
    } catch (e) {
      const message = (e as { message?: string }).message ?? 'Failed to save your changes.';
      setServerError(message);
      showErrorNotification({ title: 'Could not save', error: new Error(message) });
    }
  }

  return (
    <Stack gap="md" data-testid="apps-offsite-edit-form">
      {/* 🔴 KIND-AWARE HEADER, off the SAME `showUrlStep` flag as the wizard shape. Both
          the icon and the sentence used to be hardcoded to the off-site case, so an
          on-site listing was told to "change the link" — under an external-link icon —
          about an app that has no link and no URL step. See `listingEditHeaderCopy`. */}
      <Alert
        color="blue"
        variant="light"
        icon={showUrlStep ? <IconExternalLink size={16} /> : <IconApps size={16} />}
        title={`Editing ${edit.slug}`}
        data-testid={headerCopy.testId}
      >
        <Text size="sm">{headerCopy.blurb}</Text>
      </Alert>

      {approved && (
        <Alert
          icon={<IconInfoCircle size={16} />}
          color="blue"
          variant="light"
          data-testid="apps-offsite-edit-approved-notice"
        >
          <Text size="sm">
            This app is <b>live</b>. Your edits are staged as a revision — the current version stays
            live until a moderator re-approves your changes.
          </Text>
        </Alert>
      )}

      {/* 🔴 THE REPAIR-STATE NOTICE. Rendered ABOVE the stepper so the reason is on screen
          before the author reaches a locked field — a disabled input with its explanation
          somewhere else reads as a bug. The copy is the server's refusal, restated ahead of
          time instead of after a failed Save, and it names the way out.
          🔴 THE `scopeLocked` APPEND IS GONE, and its removal is the point rather than a
          tidy-up. It read "…so the scope justifications are locked until you republish",
          which understated the state by a long way: in the drifted state NOTHING on this
          screen can be saved, because the drifted mask rides along on every patch and
          `handleSave` aborts client-side before any of it. Worse, it sat directly after a
          sentence that said "Tagline, description and category can be edited now" — two
          claims that cannot both be true. `materialEditBlockedReason` now owns the whole
          drifted-state message, so there is ONE sentence to keep honest instead of two
          that disagreed. */}
      {materialBlockedReason && (
        <Alert
          color="yellow"
          variant="light"
          icon={<IconLock size={16} />}
          title="This app is unpublished"
          data-testid="apps-offsite-edit-material-locked-notice"
        >
          <Text size="sm">{materialBlockedReason}</Text>
        </Alert>
      )}

      {edit.hasPendingRevision && (
        <Alert
          color="orange"
          variant="light"
          icon={<IconInfoCircle size={16} />}
          data-testid="apps-offsite-edit-pending-revision-notice"
        >
          <Text size="sm">
            A revision of this app is already under review. Saving again updates that pending
            revision.
          </Text>
        </Alert>
      )}

      {serverError && (
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={16} />}
          title="Save problem"
        >
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {serverError}
          </Text>
        </Alert>
      )}

      <Stepper active={active} onStepClick={setActive} size="sm">
        {showUrlStep ? (
        <Stepper.Step
          label="URL"
          description="The link"
          data-testid="apps-offsite-wizard-step-url"
        >
          <FadeIn>
            <Stack gap="md" mt="md">
              <TextInput
                label="App URL"
                description="Your app’s public https link — users open it from the listing."
                placeholder="example.com/app"
                value={values.externalUrl}
                onChange={(e) => {
                  setField('externalUrl', e.currentTarget.value);
                  autofill.clearNote();
                }}
                onBlur={handleUrlBlur}
                onKeyDown={handleUrlKeyDown}
                error={errors.externalUrl}
                maxLength={OFFSITE_SUBMIT_LIMITS.urlMax}
                data-autofocus
                data-testid="apps-offsite-edit-url"
                // 🔴 MATERIAL. See `materialBlockedReason`. The `data-material-field` tag is
                // what lets the ledger test walk `MATERIAL_LISTING_PATCH_FIELDS` and assert
                // an input exists AND is disabled for every member — so a field added to
                // that set with no input here turns the ledger red.
                data-material-field="externalUrl"
                disabled={materialBlocked}
              />
              {values.externalUrl.trim().length === 0 && (
                <Alert
                  color="yellow"
                  variant="light"
                  icon={<IconInfoCircle size={16} />}
                  data-testid="apps-offsite-edit-url-prompt"
                >
                  <Text size="sm">
                    This listing has no App URL. Adding one lets users open your app (and lets us
                    suggest a name, description and images) — but it’s optional here.
                  </Text>
                </Alert>
              )}
              {/* The OG pull auto-fires when the URL changes to a valid https URL (blur,
                  Enter, Next, or a debounced pause) — no manual button. A subtle inline
                  status reports loading / applied / partial / empty / error. The
                  assets-step "Re-pull from site" button is the manual retry. */}
              {autofill.loading && (
                <Group gap={6} data-testid="apps-offsite-edit-meta-loading">
                  <Loader size={12} />
                  <Text size="xs" c="dimmed">
                    Looking for a name, description and images from your link…
                  </Text>
                </Group>
              )}
              {!autofill.loading && autofill.result?.status === 'error' && (
                <Text size="xs" c="red" data-testid="apps-offsite-edit-autofill-error">
                  Couldn’t read that site’s details.
                </Text>
              )}
              {!autofill.loading && autofill.result?.status === 'empty' && (
                <Text size="xs" c="dimmed" data-testid="apps-offsite-edit-autofill-empty">
                  {autofill.result.siteExposedNothing
                    ? 'Your site didn’t expose a name, description, icon or cover to pull — add them manually.'
                    : 'Nothing to autofill — your details and assets are already set.'}
                </Text>
              )}
              {!autofill.loading && autofill.result?.status === 'partial' && (
                <Text size="xs" c="dimmed" data-testid="apps-offsite-edit-autofill-partial">
                  Pulled what your link exposed — {describeMissingChannels(autofill.result.missing)}{' '}
                  {(autofill.result.missing?.length ?? 0) > 1 ? 'were' : 'was'} not found; add{' '}
                  {(autofill.result.missing?.length ?? 0) > 1 ? 'those' : 'that'} manually. Check the
                  Details and Assets steps for what we found.
                </Text>
              )}
              {!autofill.loading && autofill.result?.status === 'applied' && (
                <Alert
                  color="grape"
                  variant="light"
                  icon={<IconSparkles size={16} />}
                  data-testid="apps-offsite-edit-autofill-applied"
                >
                  <Text size="sm">
                    Pulled the latest details from your link — check the Details and Assets steps to
                    review the name, description and the suggested icon/cover.
                  </Text>
                </Alert>
              )}
              <Group justify="flex-end">
                <Button onClick={handleAdvanceFromUrl} data-testid="apps-offsite-wizard-next-url">
                  Next
                </Button>
              </Group>
            </Stack>
          </FadeIn>
        </Stepper.Step>
        ) : null}

        <Stepper.Step
          label="Details"
          description="Name & metadata"
          allowStepClick={!showUrlStep || isUrlStepComplete(values)}
          data-testid="apps-offsite-wizard-step-details"
        >
          <FadeIn>
          <Stack gap="md" mt="md">
            <TextInput
              label="Name"
              value={values.name}
              onChange={(e) => setField('name', e.currentTarget.value)}
              error={errors.name}
              maxLength={OFFSITE_SUBMIT_LIMITS.nameMax}
              required
              data-testid="apps-offsite-edit-name"
              // 🔴 MATERIAL — the listing's identity. See `materialBlockedReason`.
              data-material-field="name"
              disabled={materialBlocked}
            />

            <TextInput
              label="Slug"
              description="Your app's URL slug is fixed once created — it identifies the listing."
              value={values.slug}
              readOnly
              disabled
              rightSection={<IconLock size={14} />}
              data-testid="apps-offsite-edit-slug"
            />

            <TextInput
              label="Tagline"
              description="A short one-liner (optional)."
              value={values.tagline}
              onChange={(e) => setField('tagline', e.currentTarget.value)}
              error={errors.tagline}
              maxLength={OFFSITE_SUBMIT_LIMITS.taglineMax}
            />

            <Textarea
              label="Description"
              description="What the app does (optional)."
              autosize
              minRows={3}
              maxRows={8}
              value={values.description}
              onChange={(e) => setField('description', e.currentTarget.value)}
              error={errors.description}
              maxLength={OFFSITE_SUBMIT_LIMITS.descriptionMax}
            />

            {/* Public source repository. The copy states the re-review consequence
                up front: this is a MATERIAL field, so on an approved listing changing
                it stages a shadow revision and the change does not go live until a
                moderator approves it. An author who is not told that reads the
                unchanged live page afterwards as a bug. */}
            <TextInput
              label="Source repository"
              description={`Public link to your app's source code, shown on its store page (optional). ${SOURCE_REPO_HOSTS_LABEL} only, linking to the repository itself — e.g. https://github.com/your-org/your-app. Changing this needs moderator re-review before it goes live.`}
              placeholder="https://github.com/your-org/your-app"
              value={values.sourceRepoUrl}
              onChange={(e) => setField('sourceRepoUrl', e.currentTarget.value)}
              error={errors.sourceRepoUrl}
              maxLength={OFFSITE_SUBMIT_LIMITS.sourceRepoUrlMax}
              data-testid="apps-offsite-edit-source-repo"
              // 🔴 MATERIAL — a public outbound link a moderator approved. See
              // `materialBlockedReason`.
              data-material-field="sourceRepoUrl"
              disabled={materialBlocked}
            />

            <Group grow align="flex-start">
              <Select
                label="Category"
                placeholder="No category"
                data={OFFSITE_CATEGORY_OPTIONS}
                value={values.category}
                onChange={(v: string | null) =>
                  setField('category', (v as MarketplaceCategory) || null)
                }
                error={errors.category}
                clearable
                data-testid="apps-offsite-edit-category"
              />
              <Select
                label="Content rating"
                data={OFFSITE_CONTENT_RATING_OPTIONS}
                value={values.contentRating}
                onChange={(v: string | null) =>
                  setField('contentRating', (v as OffsiteContentRating) || 'g')
                }
                error={errors.contentRating}
                allowDeselect={false}
                data-testid="apps-offsite-edit-rating"
                // 🔴 MATERIAL, and the sharpest of the four: `contentRating` drives the
                // public SFW filter (`content_rating NOT IN ('r','x')`), so an in-place
                // change with no re-review would surface a mature listing to SFW users.
                data-material-field="contentRating"
                disabled={materialBlocked}
              />
            </Group>

            {/* 🔴 OFF-SITE ONLY. An on-site app is not an OAuth-connect integration —
                there is no linked client whose scopes a user would be consenting to, so
                the disclosure would be describing a grant that does not exist. */}
            {showUrlStep && edit.connectClientId != null && (
              <DerivedScopesDisclosure
                requestedScopes={values.requestedScopes}
                justifications={values.scopeJustifications}
                onJustificationChange={handleJustificationChange}
                // 🔴 `scopeLocked`, NOT `materialBlocked` — see `scopeDisclosureLockedForEdit`.
                // A justification edit is trivial and saves fine on an unpublished listing
                // while the scope masks agree; it is only unsaveable once they have DRIFTED,
                // because the drifted mask then rides along on every patch and the server
                // counts it as material.
                disabled={saving || scopeLocked}
                forceShowErrors={showScopeErrors}
                intro="These are your OAuth app's allowed scopes — they're derived from the app and can't be changed here. Editing a justification (or a change to your app's scopes) is sent for review on a live listing."
              />
            )}

            <Group justify={showUrlStep ? 'space-between' : 'flex-end'}>
              {showUrlStep ? (
                <Button variant="default" onClick={() => setActive(STEP_URL)}>
                  Back
                </Button>
              ) : null}
              <Button onClick={() => setActive(STEP_ASSETS)}>Next</Button>
            </Group>
          </Stack>
          </FadeIn>
        </Stepper.Step>

        <Stepper.Step
          label="Assets"
          description="Icon, cover, screenshots"
          allowStepClick={isUrlStepComplete(values)}
          data-testid="apps-offsite-wizard-step-assets"
        >
          <div data-testid="apps-offsite-wizard-assets-panel">
            {/* 🔴 THE ASSETS STEP NEEDS THE REPAIR FRAME TOO, AND IT IS THE ONLY IMAGE
                SURFACE AN OFF-SITE LISTING HAS. `capabilitiesForKind('offsite').listingMedia`
                is `false`, so `editorTabsFor` withholds the Media tab entirely and
                `ListingMediaEditor` — which DID get an unpublished frame — never mounts for
                these listings. This step is where their icon, cover and screenshots are
                edited, it became newly reachable in the repair state, and it shipped with no
                framing at all.
                🔴 AND THE WRITE SEMANTICS ARE THE SURPRISING PART, which is exactly why the
                frame has to say them. `ListingAssetStep` writes EAGERLY, one mutation per
                change, against `edit.parentId` — there is no shadow for a non-approved
                listing, so nothing here is staged and nothing is undone by leaving without
                pressing Save. That differs from the approved case the author has seen
                before AND from the scalar fields on the previous step, which do wait for
                Save. An author who assumes either would be wrong in a way that costs them
                their live imagery.
                🔴 Deliberately NOT gated on `scopeLocked`: the scope-drift dead end blocks
                the SAVE path (scalars), and these writes do not go through it. Media stays
                editable in that state, which is worth saying plainly rather than leaving
                the author to infer it from a notice that talks about saving. */}
            {materialBlockedReason && (
              <Alert
                color="yellow"
                variant="light"
                icon={<IconAlertTriangle size={16} />}
                title="This app is unpublished"
                mb="md"
                data-testid="apps-offsite-edit-assets-unpublished-notice"
              >
                <Text size="sm">
                  This app is <b>not visible in the store</b>
                  {isOwnerEdit(edit) ? <> — you unpublished it</> : <> — its owner unpublished it</>}.
                  Image changes here save <b>immediately</b> and are <b>not</b> staged for
                  review — they are not held until you press Save, and leaving this page does
                  not undo them. They appear in the store when the app is republished. Media
                  can be added while it is still scanning; it only appears once its scan
                  finishes cleanly.
                </Text>
              </Alert>
            )}
            {effectiveId ? (
              <ListingAssetStep
                listingId={effectiveId}
                contentRating={values.contentRating}
                suggestions={autofill.suggestions}
                onRepull={autofill.repull}
                repullLoading={autofill.loading}
                initial={edit.assets}
                allowRemove
                onAssetMutated={() => setAssetsDirty(true)}
              />
            ) : (
              <Group gap={8} mt="md" data-testid="apps-offsite-edit-shadow-preparing">
                <Loader size={16} />
                <Text size="sm" c="dimmed">
                  Preparing your revision…
                </Text>
              </Group>
            )}
          </div>
        </Stepper.Step>
      </Stepper>

      <Group justify="space-between">
        <Button variant="default" component={Link} href="/apps/mine" disabled={saving}>
          Cancel
        </Button>
        <Button
          onClick={() => void handleSave()}
          loading={saving}
          disabled={approved && !shadowId}
          leftSection={<IconDeviceFloppy size={16} />}
          data-testid="apps-offsite-edit-save"
        >
          {approved ? 'Save & submit for review' : 'Save'}
        </Button>
      </Group>
    </Stack>
  );
}
