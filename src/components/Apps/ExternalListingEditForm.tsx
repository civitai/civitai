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
  IconDeviceFloppy,
  IconExternalLink,
  IconInfoCircle,
  IconLock,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  OFFSITE_CATEGORY_OPTIONS,
  OFFSITE_CONTENT_RATING_OPTIONS,
  OFFSITE_SUBMIT_LIMITS,
  isUrlStepComplete,
  normalizeLinkUrl,
  scopeJustificationError,
  validateOffsiteSubmitForm,
  type OffsiteSubmitFormErrors,
  type OffsiteSubmitFormValues,
} from '~/components/Apps/offsiteSubmitFormConfig';
import { DerivedScopesDisclosure } from '~/components/Apps/DerivedScopesDisclosure';
import { FadeIn } from '~/components/Apps/wizardMotion';
import { ListingAssetStep, type MetaSuggestions } from '~/components/Apps/ListingAssetStep';
import {
  buildScalarPatch,
  editContextToForm,
  hasScalarChanges,
  isApprovedEdit,
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
const STEP_DETAILS = 1;
const STEP_ASSETS = 2;

export function ExternalListingEditForm({ edit }: { edit: ListingEditContext }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const approved = isApprovedEdit(edit);

  const [active, setActive] = useState<number>(STEP_URL);
  const [values, setValues] = useState<OffsiteSubmitFormValues>(() => editContextToForm(edit));
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

  // OG metadata auto-pull (same SSRF-safe path as create) — re-fires on a URL
  // change; NON-DESTRUCTIVE (fills only blank name/tagline; asset suggestions show
  // only for an empty asset slot, so a prefilled asset is never clobbered).
  const [metaUrl, setMetaUrl] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<MetaSuggestions>({});
  const appliedMetaRef = useRef<string | null>(null);
  const metaQuery = trpc.appListings.fetchListingMetaFromUrl.useQuery(
    { url: metaUrl ?? '' },
    { enabled: !!metaUrl, retry: false, refetchOnWindowFocus: false, staleTime: Infinity }
  );
  useEffect(() => {
    if (!metaQuery.data || appliedMetaRef.current === metaUrl) return;
    appliedMetaRef.current = metaUrl;
    const data = metaQuery.data;
    setValues((v) => ({
      ...v,
      name: v.name.trim().length === 0 && data.name ? data.name : v.name,
      tagline: v.tagline.trim().length === 0 && data.tagline ? data.tagline : v.tagline,
      // Description autofill: fill ONLY when empty, truncated to the field bound —
      // never clobbers existing copy (non-destructive OG re-pull on a URL change).
      description:
        v.description.trim().length === 0 && data.description
          ? data.description.slice(0, OFFSITE_SUBMIT_LIMITS.descriptionMax)
          : v.description,
    }));
    setSuggestions({ coverImageUrl: data.coverImageUrl, iconImageUrl: data.iconImageUrl });
  }, [metaQuery.data, metaUrl]);

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
    const result = normalizeLinkUrl(values.externalUrl);
    if (result.error) return;
    setField('externalUrl', result.url);
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
    const result = normalizeLinkUrl(values.externalUrl);
    if (result.error) {
      setErrors((prev) => ({ ...prev, externalUrl: result.error }));
      return;
    }
    setField('externalUrl', result.url);
    setErrors((prev) => ({ ...prev, externalUrl: undefined }));
    setMetaUrl(result.url); // re-fire the OG auto-pull for the (possibly new) URL
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
    void router.push('/apps/my-submissions');
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
      if (nextErrors.externalUrl) setActive(STEP_URL);
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
          void router.push('/apps/my-submissions');
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
      <Alert
        color="blue"
        variant="light"
        icon={<IconExternalLink size={16} />}
        title={`Editing ${edit.slug}`}
      >
        <Text size="sm">
          Update your external-link app. Change the link, details, or assets across the steps below,
          then save.
        </Text>
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
                onChange={(e) => setField('externalUrl', e.currentTarget.value)}
                onBlur={handleUrlBlur}
                onKeyDown={handleUrlKeyDown}
                error={errors.externalUrl}
                maxLength={OFFSITE_SUBMIT_LIMITS.urlMax}
                data-autofocus
                data-testid="apps-offsite-edit-url"
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
              <Group justify="flex-end">
                <Button onClick={handleAdvanceFromUrl} data-testid="apps-offsite-wizard-next-url">
                  Next
                </Button>
              </Group>
            </Stack>
          </FadeIn>
        </Stepper.Step>

        <Stepper.Step
          label="Details"
          description="Name & metadata"
          allowStepClick={isUrlStepComplete(values)}
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
              />
            </Group>

            {edit.connectClientId != null && (
              <DerivedScopesDisclosure
                requestedScopes={values.requestedScopes}
                justifications={values.scopeJustifications}
                onJustificationChange={handleJustificationChange}
                disabled={saving}
                forceShowErrors={showScopeErrors}
                intro="These are your OAuth app's allowed scopes — they're derived from the app and can't be changed here. Editing a justification (or a change to your app's scopes) is sent for review on a live listing."
              />
            )}

            <Group justify="space-between">
              <Button variant="default" onClick={() => setActive(STEP_URL)}>
                Back
              </Button>
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
            {effectiveId ? (
              <ListingAssetStep
                listingId={effectiveId}
                contentRating={values.contentRating}
                suggestions={suggestions}
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
        <Button variant="default" component={Link} href="/apps/my-submissions" disabled={saving}>
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
