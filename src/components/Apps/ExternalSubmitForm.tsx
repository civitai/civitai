import {
  Alert,
  Badge,
  Button,
  Code,
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
  IconCheck,
  IconExternalLink,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  OFFSITE_CATEGORY_OPTIONS,
  OFFSITE_CONTENT_RATING_OPTIONS,
  OFFSITE_SUBMIT_LIMITS,
  deriveListingFromUrl,
  emptyOffsiteSubmitForm,
  isDetailsStepComplete,
  isUrlStepComplete,
  normalizeLinkUrl,
  validateOffsiteSubmitForm,
  type OffsiteSubmitFormErrors,
  type OffsiteSubmitFormValues,
} from '~/components/Apps/offsiteSubmitFormConfig';
import { ListingAssetStep, type MetaSuggestions } from '~/components/Apps/ListingAssetStep';
import { ExternalListingEditForm } from '~/components/Apps/ExternalListingEditForm';
import type { ListingEditContext } from '~/components/Apps/offsiteEditConfig';
import type { MarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';
import type { OffsiteContentRating } from '~/server/schema/blocks/offsite-listing.schema';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * /apps/submit — "External link" mode body (W13 P3a). A native publish-request
 * flow for a pure external-link off-site app: a metadata form (design B1 creates a
 * DRAFT listing + a pending request on submit) followed by an asset step that
 * reuses the standard CF media-upload path + the (author-gated) P1 asset-CRUD procs
 * to attach an icon, a cover and ≥1 screenshot to the returned draft listing. The
 * server is the source of truth for validation; the client mirror
 * (`validateOffsiteSubmitForm`) only surfaces inline errors before the round-trip.
 *
 * DUAL-MODE: when an `edit` context is supplied (`/apps/submit?edit=<listingId>`),
 * this renders the EDIT wizard (`ExternalListingEditForm`) instead — the same
 * URL/Details/Assets steps operating on an existing listing (draft/pending in
 * place; approved via a shadow revision). The CREATE path below is unchanged.
 *
 * DARK: reachable only behind `app-blocks-author` (the gSSP gate on /apps/submit is
 * unchanged; `deIndex` stays on). Nothing renders to real users until the store
 * segment widens.
 */

type Submitted = { listingId: string; publishRequestId: string; slug: string };

/** Wizard step indices — URL → Details → Assets. */
const STEP_URL = 0;
const STEP_DETAILS = 1;
const STEP_ASSETS = 2;

export function ExternalSubmitForm({ edit }: { edit?: ListingEditContext } = {}) {
  // DUAL-MODE: an edit context routes to the edit wizard (same steps, existing
  // listing). The create body below is reached only when NOT editing.
  if (edit) return <ExternalListingEditForm edit={edit} />;

  return <ExternalCreateForm />;
}

function ExternalCreateForm() {
  const [active, setActive] = useState<number>(STEP_URL);
  const [values, setValues] = useState<OffsiteSubmitFormValues>(emptyOffsiteSubmitForm());
  const [errors, setErrors] = useState<OffsiteSubmitFormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);

  // Metadata auto-pull: once a valid URL advances to Details, fetch the target
  // page's OG metadata SERVER-side (SSRF-safe) and surface suggestions.
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
    }));
    setSuggestions({ coverImageUrl: data.coverImageUrl, iconImageUrl: data.iconImageUrl });
  }, [metaQuery.data, metaUrl]);

  const submitMutation = trpc.appListings.submitExternalListing.useMutation({
    onSuccess: (res: Submitted) => {
      setSubmitted(res);
      setServerError(null);
      setActive(STEP_ASSETS);
      showSuccessNotification({ message: 'Draft created. Add your assets to finish.' });
    },
    onError: (e: { message: string }) => {
      setServerError(e.message);
      showErrorNotification({ title: 'Could not create the listing', error: new Error(e.message) });
    },
  });

  function setField<K extends keyof OffsiteSubmitFormValues>(
    key: K,
    value: OffsiteSubmitFormValues[K]
  ) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function applyNormalizedUrl(normalized: string) {
    const derived = deriveListingFromUrl(normalized);
    setValues((v) => ({
      ...v,
      externalUrl: normalized,
      name: v.name.trim().length === 0 && derived.name ? derived.name : v.name,
      slug: v.slug.trim().length === 0 && derived.slug ? derived.slug : v.slug,
    }));
  }

  function handleUrlBlur() {
    const result = normalizeLinkUrl(values.externalUrl);
    if (result.error) return;
    applyNormalizedUrl(result.url);
    setErrors((prev) => ({ ...prev, externalUrl: undefined }));
  }

  function handleAdvanceFromUrl() {
    const result = normalizeLinkUrl(values.externalUrl);
    if (result.error) {
      setErrors((prev) => ({ ...prev, externalUrl: result.error }));
      return;
    }
    applyNormalizedUrl(result.url);
    setErrors((prev) => ({ ...prev, externalUrl: undefined }));
    setMetaUrl(result.url);
    setActive(STEP_DETAILS);
  }

  function handleUrlKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    handleAdvanceFromUrl();
  }

  function handleDetailsKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (isDetailsStepComplete(values)) handleCreateDraft();
  }

  function handleCreateDraft() {
    const nextErrors = validateOffsiteSubmitForm(values);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    submitMutation.mutate({
      slug: values.slug.trim(),
      name: values.name.trim(),
      externalUrl: values.externalUrl.trim(),
      tagline: values.tagline.trim() || undefined,
      description: values.description.trim() || undefined,
      category: values.category ?? undefined,
      contentRating: values.contentRating,
      changelog: values.changelog.trim() || undefined,
    });
  }

  function handleStepClick(step: number) {
    if (submitted) return;
    if (step === STEP_URL) {
      setActive(STEP_URL);
      return;
    }
    if (step === STEP_DETAILS) {
      const result = normalizeLinkUrl(values.externalUrl);
      if (result.error) return;
      applyNormalizedUrl(result.url);
      setMetaUrl(result.url);
      setActive(STEP_DETAILS);
    }
  }

  const busy = submitMutation.isPending;

  return (
    <Stack gap="md" data-testid="apps-offsite-submit-form">
      <Alert
        color="blue"
        variant="light"
        icon={<IconExternalLink size={16} />}
        title="External link app"
      >
        <Text size="sm">
          List an app hosted off-site. Users get a card with a <b>Visit ↗</b> button that opens your
          https link in a new tab — no bundle, no install. A moderator reviews it before it appears.
        </Text>
      </Alert>

      {serverError && (
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={16} />}
          title="Submission problem"
        >
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {serverError}
          </Text>
        </Alert>
      )}

      <Stepper active={active} onStepClick={handleStepClick} allowNextStepsSelect={false} size="sm">
        <Stepper.Step
          label="URL"
          description="The link"
          allowStepClick={!submitted}
          data-testid="apps-offsite-wizard-step-url"
        >
          <Stack gap="md" mt="md">
            <TextInput
              label="Link URL"
              description="Where users will land when they click your app. Just type the domain — we'll add https:// and suggest a name + slug from it."
              placeholder="example.com/app"
              value={values.externalUrl}
              onChange={(e) => setField('externalUrl', e.currentTarget.value)}
              onBlur={handleUrlBlur}
              onKeyDown={handleUrlKeyDown}
              error={errors.externalUrl}
              maxLength={OFFSITE_SUBMIT_LIMITS.urlMax}
              required
              disabled={busy}
              data-autofocus
              data-testid="apps-offsite-submit-url"
            />
            <Group justify="space-between">
              <Button
                variant="default"
                component={Link}
                href="/apps/my-submissions"
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                onClick={handleAdvanceFromUrl}
                disabled={busy}
                data-testid="apps-offsite-wizard-next-url"
              >
                Next
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>

        <Stepper.Step
          label="Details"
          description="Name & metadata"
          allowStepClick={!submitted && isUrlStepComplete(values)}
          data-testid="apps-offsite-wizard-step-details"
        >
          <Stack gap="md" mt="md">
            {metaQuery.isFetching && (
              <Group gap={6} data-testid="apps-offsite-meta-loading">
                <Loader size={12} />
                <Text size="xs" c="dimmed">
                  Looking for a name, description and images from your link…
                </Text>
              </Group>
            )}
            {!metaQuery.isFetching &&
              metaQuery.isSuccess &&
              !metaQuery.data.name &&
              !metaQuery.data.tagline &&
              !metaQuery.data.coverImageUrl &&
              !metaQuery.data.iconImageUrl && (
                <Text size="xs" c="dimmed" data-testid="apps-offsite-meta-empty">
                  No suggestions found — fill in the details and upload assets manually.
                </Text>
              )}
            <TextInput
              label="Name"
              description="Prefilled from your URL — edit as needed."
              placeholder="My External App"
              value={values.name}
              onChange={(e) => setField('name', e.currentTarget.value)}
              onKeyDown={handleDetailsKeyDown}
              error={errors.name}
              maxLength={OFFSITE_SUBMIT_LIMITS.nameMax}
              required
              disabled={busy}
              data-autofocus
              data-testid="apps-offsite-submit-name"
            />

            <TextInput
              label="Slug"
              description={`Your app's URL slug (${OFFSITE_SUBMIT_LIMITS.slugMin}–${OFFSITE_SUBMIT_LIMITS.slugMax} chars, lowercase a–z / 0–9 / hyphens). Prefilled from your URL.`}
              placeholder="my-external-app"
              value={values.slug}
              onChange={(e) => setField('slug', e.currentTarget.value)}
              onKeyDown={handleDetailsKeyDown}
              error={errors.slug}
              maxLength={OFFSITE_SUBMIT_LIMITS.slugMax}
              required
              disabled={busy}
              data-testid="apps-offsite-submit-slug"
            />

            <TextInput
              label="Tagline"
              description="A short one-liner (optional)."
              value={values.tagline}
              onChange={(e) => setField('tagline', e.currentTarget.value)}
              onKeyDown={handleDetailsKeyDown}
              error={errors.tagline}
              maxLength={OFFSITE_SUBMIT_LIMITS.taglineMax}
              disabled={busy}
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
              disabled={busy}
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
                disabled={busy}
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
                disabled={busy}
              />
            </Group>

            <Textarea
              label="What is this app? (optional)"
              description="A note for the reviewer — recorded on the request."
              autosize
              minRows={2}
              maxRows={6}
              value={values.changelog}
              onChange={(e) => setField('changelog', e.currentTarget.value)}
              error={errors.changelog}
              maxLength={OFFSITE_SUBMIT_LIMITS.changelogMax}
              disabled={busy}
            />

            <Group justify="space-between">
              <Button
                variant="default"
                onClick={() => setActive(STEP_URL)}
                disabled={busy}
                data-testid="apps-offsite-wizard-back-details"
              >
                Back
              </Button>
              <Button
                onClick={handleCreateDraft}
                loading={busy}
                disabled={!isDetailsStepComplete(values)}
                leftSection={<IconExternalLink size={16} />}
                data-testid="apps-offsite-submit-create"
              >
                Create draft
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>

        <Stepper.Step
          label="Assets"
          description="Icon, cover, screenshots"
          allowStepClick={false}
          data-testid="apps-offsite-wizard-step-assets"
        >
          <div data-testid="apps-offsite-wizard-assets-panel">
            {submitted ? (
              <ListingAssetStep
                listingId={submitted.listingId}
                contentRating={values.contentRating}
                suggestions={suggestions}
                header={
                  <Alert
                    color="green"
                    variant="light"
                    icon={<IconCheck size={16} />}
                    title="Draft created"
                  >
                    <Text size="sm">
                      <Code>{submitted.slug}</Code> is a pending off-site submission. Attach an icon,
                      a cover and at least one screenshot below — a moderator can only approve an
                      asset-complete listing. Content rating:{' '}
                      <Badge size="xs">{values.contentRating}</Badge>
                    </Text>
                  </Alert>
                }
                footer={
                  <Group justify="flex-end">
                    <Button
                      component={Link}
                      href="/apps/my-submissions"
                      rightSection={<IconExternalLink size={16} />}
                    >
                      View my submissions
                    </Button>
                  </Group>
                }
              />
            ) : (
              <Alert color="gray" variant="light" mt="md">
                <Text size="sm">Create the draft on the previous step to add assets.</Text>
              </Alert>
            )}
          </div>
        </Stepper.Step>
      </Stepper>
    </Stack>
  );
}
