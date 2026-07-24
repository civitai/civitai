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
  IconPlugConnected,
  IconSparkles,
  IconWorld,
} from '@tabler/icons-react';
import Link from 'next/link';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  OFFSITE_CATEGORY_OPTIONS,
  OFFSITE_CONTENT_RATING_OPTIONS,
  OFFSITE_SUBMIT_LIMITS,
  deriveListingFromUrl,
  deriveScopesFromClient,
  emptyOffsiteSubmitForm,
  isClientStepComplete,
  isCreateDetailsStepComplete,
  isCreateUrlStepComplete,
  normalizeLinkUrl,
  toSubmitExternalInput,
  validateExternalCreateForm,
  type OffsiteSubmitFormErrors,
  type OffsiteSubmitFormValues,
} from '~/components/Apps/offsiteSubmitFormConfig';
import { DerivedScopesDisclosure } from '~/components/Apps/DerivedScopesDisclosure';
import { ListingAssetStep, type MetaSuggestions } from '~/components/Apps/ListingAssetStep';
import { ExternalListingEditForm } from '~/components/Apps/ExternalListingEditForm';
import { FadeIn } from '~/components/Apps/wizardMotion';
import type { ListingEditContext } from '~/components/Apps/offsiteEditConfig';
import type { MarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';
import type { OffsiteContentRating } from '~/server/schema/blocks/offsite-listing.schema';
import { isAppBlockOauthClientId } from '~/shared/constants/block-scope.constants';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * /apps/submit — "External app" mode body (W13 P3a, MERGED external+connect model).
 *
 * Every external app IS an OAuth app, so this ONE flow links a registered OAuth
 * client the caller OWNS (the derived scope subset + per-SENSITIVE-scope
 * justifications) and carries the app's public **App URL** plus display metadata +
 * assets. Design B1: submit creates a DRAFT listing + a pending request, then the
 * author attaches assets. The server (`submitExternalListing`) is the source of
 * truth; the client mirror (`validateExternalCreateForm`) only surfaces inline
 * errors before the round-trip.
 *
 * WIZARD ORDER (redesigned): **App URL → App & scopes → Details → Assets**. The App
 * URL is the FIRST step and is REQUIRED — a valid https URL gates progression and is
 * the autofill trigger (its OG metadata prefills the name / slug / description and
 * suggests a cover + icon). The whole flow is subtly animated (Mantine
 * `Transition`/`Collapse` via {@link FadeIn}, `prefers-reduced-motion` respected).
 *
 * DISCLOSURE/REVIEW-ONLY: the requested-scope subset is stored + reviewed; it does NOT
 * gate OAuth token issuance (the client's `allowedScopes` stays the runtime ceiling
 * via the existing consent flow).
 *
 * DUAL-MODE: when an `edit` context is supplied (`/apps/submit?edit=<listingId>`),
 * this renders the EDIT wizard (`ExternalListingEditForm`) instead.
 *
 * DARK: reachable only behind `app-blocks-author` (the gSSP gate on /apps/submit is
 * unchanged; `deIndex` stays on).
 */

type Submitted = { listingId: string; publishRequestId: string; slug: string };

/** Wizard step indices — App URL → App & scopes → Details → Assets. */
const STEP_URL = 0;
const STEP_APP = 1;
const STEP_DETAILS = 2;
const STEP_ASSETS = 3;

export function ExternalSubmitForm({ edit }: { edit?: ListingEditContext } = {}) {
  // DUAL-MODE: an edit context routes to the edit wizard (metadata edit, existing
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
  // Flip true once the author has tried to leave the scopes step so every empty
  // SENSITIVE justification surfaces its required error at once.
  const [showScopeErrors, setShowScopeErrors] = useState(false);

  // App-URL metadata auto-pull: once a valid URL is entered, fetch the target page's
  // OG metadata SERVER-side (SSRF-safe) and surface prefill + asset suggestions.
  const [metaUrl, setMetaUrl] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<MetaSuggestions>({});
  const [autofillApplied, setAutofillApplied] = useState(false);
  const appliedMetaRef = useRef<string | null>(null);

  const clientsQuery = trpc.oauthClient.getAll.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  // The caller's OWN OAuth clients, EXCLUDING App-Block clients (managed by the App
  // Blocks flow — never a hand-authored target). `getAll` is already scoped to the
  // caller (`userId`), so this is the ownership filter + the app-block exclude.
  const clients = useMemo(
    () => (clientsQuery.data ?? []).filter((c) => !isAppBlockOauthClientId(c.id)),
    [clientsQuery.data]
  );

  const selectedClient = useMemo(
    () => clients.find((c) => c.id === values.connectClientId) ?? null,
    [clients, values.connectClientId]
  );
  const allowedScopes = selectedClient?.allowedScopes ?? 0;

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
      // a suggestion the author can freely edit or clear (never clobbers typed text).
      description:
        v.description.trim().length === 0 && data.description
          ? data.description.slice(0, OFFSITE_SUBMIT_LIMITS.descriptionMax)
          : v.description,
    }));
    setSuggestions({ coverImageUrl: data.coverImageUrl, iconImageUrl: data.iconImageUrl });
    // Reveal the "we found your details" note whenever the link yielded anything the
    // author can accept (computed from `data` directly — NOT the async setValues
    // updater, whose side effects haven't run yet at this point).
    if (
      data.name ||
      data.tagline ||
      data.description ||
      data.coverImageUrl ||
      data.iconImageUrl
    ) {
      setAutofillApplied(true);
    }
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

  function handleSelectClient(clientId: string | null) {
    // Changing the client RE-DERIVES the requested scopes from the new client's
    // `allowedScopes` (the listing requests exactly the client's set — no picker) and
    // re-keys the justifications, dropping any whose scope the new client doesn't have.
    const nextClient = clientId ? clients.find((c) => c.id === clientId) ?? null : null;
    const nextAllowed = nextClient?.allowedScopes ?? 0;
    setValues((v) => deriveScopesFromClient({ ...v, connectClientId: clientId }, nextAllowed));
    setShowScopeErrors(false);
    setErrors((prev) => ({ ...prev, connectClientId: undefined, requestedScopes: undefined }));
  }

  function handleJustificationChange(key: string, text: string) {
    setValues((v) => ({
      ...v,
      scopeJustifications: { ...v.scopeJustifications, [key]: text },
    }));
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

  // The App URL is REQUIRED. Blur tidies it into canonical https (no blocking); the
  // required gate is enforced on advance.
  function handleUrlBlur() {
    if (values.externalUrl.trim().length === 0) return;
    const result = normalizeLinkUrl(values.externalUrl);
    if (result.error) {
      setErrors((prev) => ({ ...prev, externalUrl: result.error }));
      return;
    }
    applyNormalizedUrl(result.url);
    setMetaUrl(result.url);
    setErrors((prev) => ({ ...prev, externalUrl: undefined }));
  }

  function handleAdvanceFromUrl() {
    if (values.externalUrl.trim().length === 0) {
      setErrors((prev) => ({ ...prev, externalUrl: 'Enter your app’s URL to continue.' }));
      return;
    }
    const result = normalizeLinkUrl(values.externalUrl);
    if (result.error) {
      setErrors((prev) => ({ ...prev, externalUrl: result.error }));
      return;
    }
    applyNormalizedUrl(result.url);
    setMetaUrl(result.url);
    setErrors((prev) => ({ ...prev, externalUrl: undefined }));
    setActive(STEP_APP);
  }

  function handleUrlKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    handleAdvanceFromUrl();
  }

  function handleAdvanceFromApp() {
    if (!isClientStepComplete(values, allowedScopes)) {
      setShowScopeErrors(true);
      setErrors((prev) => ({
        ...prev,
        connectClientId: values.connectClientId ? undefined : 'Choose one of your OAuth apps.',
      }));
      return;
    }
    setShowScopeErrors(false);
    setErrors((prev) => ({ ...prev, connectClientId: undefined, requestedScopes: undefined }));
    setActive(STEP_DETAILS);
  }

  function handleDetailsKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (isCreateDetailsStepComplete(values, allowedScopes)) handleCreateDraft();
  }

  function handleCreateDraft() {
    const nextErrors = validateExternalCreateForm(values, allowedScopes);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      // Steer the author back to the step carrying the first error.
      if (nextErrors.externalUrl) setActive(STEP_URL);
      else if (nextErrors.connectClientId || nextErrors.requestedScopes || nextErrors.scopeJustifications) {
        setShowScopeErrors(true);
        setActive(STEP_APP);
      }
      return;
    }
    submitMutation.mutate(toSubmitExternalInput(values));
  }

  function handleStepClick(step: number) {
    if (submitted) return;
    if (step === STEP_URL) setActive(STEP_URL);
    else if (step === STEP_APP && isCreateUrlStepComplete(values)) setActive(STEP_APP);
    else if (
      step === STEP_DETAILS &&
      isCreateUrlStepComplete(values) &&
      isClientStepComplete(values, allowedScopes)
    ) {
      setActive(STEP_DETAILS);
    }
  }

  const busy = submitMutation.isPending;
  const clientOptions = clients.map((c) => ({ value: c.id, label: c.name }));

  return (
    <Stack gap="md" data-testid="apps-offsite-submit-form">
      <Alert
        color="blue"
        variant="light"
        icon={<IconPlugConnected size={16} />}
        title="List an external app"
      >
        <Text size="sm">
          List an app hosted off-site by linking your registered OAuth app so users can grant it
          access. Start with your app’s URL — we’ll pull in a name, description and images you can
          tweak. A moderator reviews it before it appears. This does not change what your app can
          do: your OAuth client’s allowed scopes stay the limit.
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
          label="App URL"
          description="Where it lives"
          allowStepClick={!submitted}
          data-testid="apps-offsite-wizard-step-url"
        >
          <FadeIn>
            <Stack gap="md" mt="md">
              <TextInput
                label="App URL"
                description="Your app’s public https link — users open it from the listing, and we’ll suggest a name, description and images from it."
                placeholder="example.com/app"
                leftSection={<IconWorld size={16} />}
                value={values.externalUrl}
                onChange={(e) => setField('externalUrl', e.currentTarget.value)}
                onBlur={handleUrlBlur}
                onKeyDown={handleUrlKeyDown}
                error={errors.externalUrl}
                maxLength={OFFSITE_SUBMIT_LIMITS.urlMax}
                required
                withAsterisk
                data-autofocus
                data-testid="apps-offsite-submit-url"
              />

              {metaQuery.isFetching && (
                <Group gap={6} data-testid="apps-offsite-meta-loading">
                  <Loader size={12} />
                  <Text size="xs" c="dimmed">
                    Looking for a name, description and images from your link…
                  </Text>
                </Group>
              )}

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
                  disabled={busy || !isCreateUrlStepComplete(values)}
                  data-testid="apps-offsite-wizard-next-url"
                >
                  Next
                </Button>
              </Group>
            </Stack>
          </FadeIn>
        </Stepper.Step>

        <Stepper.Step
          label="App & scopes"
          description="Your OAuth app"
          allowStepClick={!submitted && isCreateUrlStepComplete(values)}
          data-testid="apps-offsite-wizard-step-app"
        >
          <FadeIn>
            <Stack gap="md" mt="md">
              {clientsQuery.isLoading ? (
                <Group gap={8} data-testid="apps-offsite-clients-loading">
                  <Loader size={16} />
                  <Text size="sm" c="dimmed">
                    Loading your OAuth apps…
                  </Text>
                </Group>
              ) : clients.length === 0 ? (
                <Alert color="gray" variant="light" data-testid="apps-offsite-no-clients">
                  <Text size="sm">
                    You have no eligible OAuth apps. Register one in your account settings first,
                    then come back to list it.
                  </Text>
                </Alert>
              ) : (
                <>
                  <Select
                    label="OAuth app"
                    description="One of your registered OAuth clients. Users will grant this app access."
                    placeholder="Choose an app"
                    data={clientOptions}
                    value={values.connectClientId}
                    onChange={handleSelectClient}
                    error={errors.connectClientId}
                    disabled={busy}
                    required
                    data-testid="apps-offsite-client-select"
                  />

                  {selectedClient && (
                    <DerivedScopesDisclosure
                      requestedScopes={values.requestedScopes}
                      justifications={values.scopeJustifications}
                      onJustificationChange={handleJustificationChange}
                      disabled={busy}
                      forceShowErrors={showScopeErrors}
                    />
                  )}
                </>
              )}

              <Group justify="space-between">
                <Button
                  variant="default"
                  onClick={() => setActive(STEP_URL)}
                  disabled={busy}
                  data-testid="apps-offsite-wizard-back-app"
                >
                  Back
                </Button>
                <Button
                  onClick={handleAdvanceFromApp}
                  disabled={busy || !isClientStepComplete(values, allowedScopes)}
                  data-testid="apps-offsite-wizard-next-app"
                >
                  Next
                </Button>
              </Group>
            </Stack>
          </FadeIn>
        </Stepper.Step>

        <Stepper.Step
          label="Details"
          description="Name & metadata"
          allowStepClick={
            !submitted && isCreateUrlStepComplete(values) && isClientStepComplete(values, allowedScopes)
          }
          data-testid="apps-offsite-wizard-step-details"
        >
          <FadeIn>
            <Stack gap="md" mt="md">
              {autofillApplied && (
                <FadeIn>
                  <Alert
                    color="grape"
                    variant="light"
                    icon={<IconSparkles size={16} />}
                    data-testid="apps-offsite-autofill-reveal"
                  >
                    <Text size="sm">
                      We pulled these details from your link — edit anything, or clear what you
                      don’t want.
                    </Text>
                  </Alert>
                </FadeIn>
              )}
              {metaQuery.isFetching && (
                <Group gap={6} data-testid="apps-offsite-meta-loading">
                  <Loader size={12} />
                  <Text size="xs" c="dimmed">
                    Looking for a name, description and images from your link…
                  </Text>
                </Group>
              )}
              <TextInput
                label="Name"
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
                description={`Your app's URL slug (${OFFSITE_SUBMIT_LIMITS.slugMin}–${OFFSITE_SUBMIT_LIMITS.slugMax} chars, lowercase a–z / 0–9 / hyphens).`}
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
                data-testid="apps-offsite-submit-description"
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
                  onClick={() => setActive(STEP_APP)}
                  disabled={busy}
                  data-testid="apps-offsite-wizard-back-details"
                >
                  Back
                </Button>
                <Button
                  onClick={handleCreateDraft}
                  loading={busy}
                  disabled={!isCreateDetailsStepComplete(values, allowedScopes)}
                  leftSection={<IconExternalLink size={16} />}
                  data-testid="apps-offsite-submit-create"
                >
                  Create draft
                </Button>
              </Group>
            </Stack>
          </FadeIn>
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
