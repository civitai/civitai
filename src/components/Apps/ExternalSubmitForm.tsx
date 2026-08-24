import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Stepper,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData } from '@tanstack/react-query';
import {
  IconAlertTriangle,
  IconCheck,
  IconExternalLink,
  IconPlugConnected,
  IconSparkles,
  IconWorld,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  OFFSITE_CATEGORY_OPTIONS,
  OFFSITE_CONTENT_RATING_OPTIONS,
  OFFSITE_SUBMIT_LIMITS,
  SOURCE_REPO_HOSTS_LABEL,
  deriveListingFromUrl,
  deriveScopesFromClient,
  emptyOffsiteSubmitForm,
  isClientStepComplete,
  isCreateDetailsStepComplete,
  isCreateUrlStepComplete,
  isOffsiteSubmitFormDirty,
  toSubmitExternalInput,
  validateExternalCreateForm,
  type OffsiteSubmitFormErrors,
  type OffsiteSubmitFormValues,
} from '~/components/Apps/offsiteSubmitFormConfig';
import { STANDALONE_KIND_LABEL } from '~/components/Apps/listingKindLabels';
import { useEligibleOauthClients } from '~/components/Apps/useEligibleOauthClients';
import { DerivedScopesDisclosure } from '~/components/Apps/DerivedScopesDisclosure';
import { ListingAssetStep } from '~/components/Apps/ListingAssetStep';
import { describeMissingChannels } from '~/components/Apps/listingAutofillStatus';
import { useListingAutofill } from '~/components/Apps/useListingAutofill';
import { ExternalListingEditForm } from '~/components/Apps/ExternalListingEditForm';
import { FadeIn } from '~/components/Apps/wizardMotion';
import type { ListingEditContext } from '~/components/Apps/offsiteEditConfig';
import type { MarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';
import type { OffsiteContentRating } from '~/server/schema/blocks/offsite-listing.schema';
import { offsiteContentRatingLabel } from '~/shared/constants/browsingLevel.constants';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * A moderator's global-search OAuth-client option — the SECRET-FREE projection
 * returned by `oauthClient.searchForModerator` (plus what we pin for the selected
 * FOREIGN client). Kept minimal so a searched client not in the caller's own list
 * still resolves its `allowedScopes` for `deriveScopesFromClient`.
 */
type ModClientOption = {
  id: string;
  name: string;
  allowedScopes: number;
  user: { id: number; username: string | null } | null;
};

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

/**
 * Plain-language answer to "what is an OAuth app and why does listing need one?".
 *
 * Pinned as a constant so the test asserts the WHOLE normalised sentence rather than
 * a keyword — a guard on words is walkable by rewording, and this string's job is to
 * carry an explanation, not a vocabulary.
 */
export const OAUTH_REQUIREMENT_EXPLAINER =
  'An OAuth app is the registration that lets people sign in to your app with their Civitai account, and that decides what your app may read or do on their behalf. Every standalone listing links to one, so visitors can see up front what they would be granting.';

/** Where Cancel / "View my submissions" go. One constant, two call sites. */
const MY_APPS_HREF = '/apps/mine';

/** The exact sentence shown when the author owns no eligible OAuth client. */
export const NO_ELIGIBLE_CLIENTS_TEXT =
  'You have no eligible OAuth apps. Register one in your account settings first, then come back to list it.';

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

  // App-URL metadata auto-pull is owned by the shared `useListingAutofill` hook
  // (declared below `applyNormalizedUrl`): once a valid https URL is entered — on blur,
  // Enter, step-advance, OR a debounced pause in typing — it fetches the target page's
  // OG metadata SERVER-side (SSRF-safe) and surfaces fill-if-empty prefill + asset
  // suggestions. Host-derived name kept as a FALLBACK only — used to fill `name` when
  // the OG-meta fetch settles with no usable `<title>` (the real page title is
  // preferred); never seeded up front so the title can win.
  const hostNameFallbackRef = useRef<string>('');
  // Latest `values` for the hook's emptiness reads (its async `setValues` updater hasn't
  // committed yet when the status note is computed).
  const valuesRef = useRef(values);
  valuesRef.current = values;

  const currentUser = useCurrentUser();
  const isModerator = !!currentUser?.isModerator;

  // 🔴 ONE eligibility predicate, shared with the mode selector — the two surfaces
  // that tell an author about this prerequisite must not be able to disagree. The
  // filter (own clients, App-Block clients excluded) lives in the hook, not here.
  const eligibleClients = useEligibleOauthClients();
  const clients = eligibleClients.clients;

  // MODERATOR picker: a debounced async global search over ALL non-App-Block clients.
  // An empty search returns the mod's own clients (server default), so mods get the
  // same starting point as regular devs before typing. Non-mods never fire this.
  const [clientSearch, setClientSearch] = useState('');
  const [debouncedClientSearch] = useDebouncedValue(clientSearch.trim(), 300);
  const modSearchQuery = trpc.oauthClient.searchForModerator.useQuery(
    { query: debouncedClientSearch || undefined },
    {
      enabled: isModerator,
      retry: false,
      refetchOnWindowFocus: false,
      placeholderData: keepPreviousData,
    }
  );
  const modResults = useMemo<ModClientOption[]>(
    () => modSearchQuery.data?.items ?? [],
    [modSearchQuery.data]
  );

  // The full selected-client object — the ONLY source of `allowedScopes` for mods,
  // because a searched FOREIGN client is not in the caller's own `clients` list. Also
  // pinned into the Select's `data` so Mantine can render its label across searches.
  const [selectedClientData, setSelectedClientData] = useState<ModClientOption | null>(null);

  // Options the mod Select can render/select from: the current search results, PLUS
  // the pinned selected client (so its label survives when a later search drops it).
  const modOptionClients = useMemo<ModClientOption[]>(() => {
    const map = new Map<string, ModClientOption>();
    for (const c of modResults) map.set(c.id, c);
    if (selectedClientData && !map.has(selectedClientData.id)) {
      map.set(selectedClientData.id, selectedClientData);
    }
    return [...map.values()];
  }, [modResults, selectedClientData]);

  // Role-aware resolution of the selected client + its scope ceiling. Mods resolve from
  // the pinned/search object (FOREIGN-client safe); non-mods from their own list.
  const ownSelectedClient = useMemo(
    () => clients.find((c) => c.id === values.connectClientId) ?? null,
    [clients, values.connectClientId]
  );
  const selectedClient = isModerator
    ? values.connectClientId === selectedClientData?.id
      ? selectedClientData
      : null
    : ownSelectedClient;
  const allowedScopes = selectedClient?.allowedScopes ?? 0;

  // Shared autofill core (auto-trigger + fill-if-empty apply + suggestions + status +
  // repull). CREATE prefers the page <title>, falling back to the host-derived name;
  // every asset slot starts empty so all suggestions are actionable (default). The
  // Name input lives on the later Details step, so the fetch has time to settle before
  // the author sees it.
  const autofill = useListingAutofill({
    externalUrl: values.externalUrl,
    setValues,
    valuesRef,
    nameFallbackRef: hostNameFallbackRef,
    onBeforeFire: applyNormalizedUrl,
  });

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
    // Mods resolve the picked client from the global-search options (which may be a
    // FOREIGN client) and PIN it so its scopes + label survive later searches; non-mods
    // resolve from their own client list, unchanged.
    let nextAllowed = 0;
    if (isModerator) {
      const nextClient = clientId ? modOptionClients.find((c) => c.id === clientId) ?? null : null;
      setSelectedClientData(nextClient);
      nextAllowed = nextClient?.allowedScopes ?? 0;
    } else {
      const nextClient = clientId ? clients.find((c) => c.id === clientId) ?? null : null;
      nextAllowed = nextClient?.allowedScopes ?? 0;
    }
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
    // Stash the host-derived name as a FALLBACK for the meta effect — do NOT set the
    // `name` field here. Setting it up front (this fires before the OG-meta fetch
    // resolves) would make the meta effect's "only fill if empty" guard skip the real
    // page `<title>`, so the uglier host name would preempt the better title. The slug
    // IS set immediately (slugs are hyphenated + there's no better source for them).
    hostNameFallbackRef.current = derived.name;
    setValues((v) => ({
      ...v,
      externalUrl: normalized,
      slug: v.slug.trim().length === 0 && derived.slug ? derived.slug : v.slug,
    }));
  }

  // The App URL is REQUIRED. Blur tidies it into canonical https (no blocking) and
  // auto-fires the OG pull via the hook (once per distinct URL); the required gate is
  // enforced on advance. `onBeforeFire` (applyNormalizedUrl) canonicalises + derives
  // the slug + stashes the host-name fallback when the pull fires.
  function handleUrlBlur() {
    if (values.externalUrl.trim().length === 0) return;
    const { error } = autofill.triggerFromUrl(values.externalUrl);
    setErrors((prev) => ({ ...prev, externalUrl: error }));
  }

  function handleAdvanceFromUrl() {
    if (values.externalUrl.trim().length === 0) {
      setErrors((prev) => ({ ...prev, externalUrl: 'Enter your app’s URL to continue.' }));
      return;
    }
    const { error } = autofill.triggerFromUrl(values.externalUrl);
    if (error) {
      setErrors((prev) => ({ ...prev, externalUrl: error }));
      return;
    }
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
      else if (
        nextErrors.connectClientId ||
        nextErrors.requestedScopes ||
        nextErrors.scopeJustifications
      ) {
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

  /**
   * 🔴 CANCEL DISCARDS EVERYTHING, SILENTLY — so confirm, but ONLY when there is
   * something to lose.
   *
   * `Cancel` used to be a plain `<Button component={Link} href="/apps/mine">`: one
   * click and every field entered (URL, name, description, the scope justifications)
   * was gone with no warning and no undo. It is now a real button that asks first.
   *
   * It deliberately does NOT ask on a pristine form. A confirmation that fires on an
   * untouched wizard is a nag, and a nag is dismissed reflexively — which would make
   * the dialog worthless on the one occasion it matters. {@link isOffsiteSubmitFormDirty}
   * owns that predicate.
   */
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const router = useRouter();

  function leaveToMyApps() {
    void router.push(MY_APPS_HREF);
  }

  function handleCancel() {
    if (isOffsiteSubmitFormDirty(values)) {
      setConfirmDiscard(true);
      return;
    }
    leaveToMyApps();
  }

  const busy = submitMutation.isPending;
  const clientOptions = clients.map((c) => ({ value: c.id, label: c.name }));
  const modClientOptions = modOptionClients.map((c) => ({
    value: c.id,
    label: `${c.name} — by @${c.user?.username ?? 'unknown'}`,
  }));

  // Create-client deeplink for EVERYONE (mods + regular devs) — opens the OAuth-apps
  // card on /user/account in a NEW TAB so the in-progress wizard isn't lost. Rendered
  // ONCE, persistently below the picker. Deliberately NOT reused as the mod Select's
  // `nothingFoundMessage` — see `noClientsFoundMessage` for why.
  const createClientLink = (
    <Anchor
      href="/user/account"
      target="_blank"
      rel="noopener noreferrer"
      size="xs"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      data-testid="apps-offsite-create-client-link"
    >
      Don’t see your app? Create an OAuth client
      <IconExternalLink size={12} />
    </Anchor>
  );

  // Empty-state copy for the mod global-search Select. Mantine renders
  // `nothingFoundMessage` via `Combobox.Empty` INSIDE `Combobox.Options`, which carries
  // `role="listbox"` — and because setting `nothingFoundMessage` flips `hiddenWhenEmpty`
  // to false while `Combobox` defaults to `keepMounted: true`, that node stays in the DOM
  // (merely `display:none`) whenever the option list is empty, open or not. So this must
  // stay NON-INTERACTIVE prose: an <a> here would be a `link` inside a `listbox` (not a
  // permitted child role, and it breaks combobox arrow/Enter semantics while the dropdown
  // is open), and it would duplicate `createClientLink` — two identical controls with the
  // same accessible name reachable at once on exactly the no-results path this message
  // exists for. The actionable affordance is the persistent link rendered below.
  const noClientsFoundMessage = (
    <Text size="xs" c="dimmed" data-testid="apps-offsite-client-search-empty">
      No matching apps. Use the “Create an OAuth client” link below the picker to register one.
    </Text>
  );

  return (
    <Stack gap="md" data-testid="apps-offsite-submit-form">
      {/* An INLINE Mantine Modal rather than `@mantine/modals`' openConfirmModal:
          this component is rendered in isolation by the browser suite, which has no
          ModalsProvider, and a confirmation nobody can test is a confirmation nobody
          can trust. */}
      <Modal
        opened={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title="Discard this submission?"
        data-testid="apps-offsite-discard-modal"
      >
        <Stack gap="md">
          <Text size="sm">
            You’ve entered details for this listing and nothing has been saved yet. Leaving now
            discards them.
          </Text>
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => setConfirmDiscard(false)}
              data-testid="apps-offsite-discard-cancel"
            >
              Keep editing
            </Button>
            <Button color="red" onClick={leaveToMyApps} data-testid="apps-offsite-discard-confirm">
              Discard and leave
            </Button>
          </Group>
        </Stack>
      </Modal>

      <Alert
        color="blue"
        variant="light"
        icon={<IconPlugConnected size={16} />}
        title={`List a ${STANDALONE_KIND_LABEL} app`}
      >
        <Text size="sm">
          List a {STANDALONE_KIND_LABEL} app hosted elsewhere by linking your registered OAuth app
          so users can grant it access. Start with your app’s URL — we’ll pull in a name,
          description and images you can tweak. A moderator reviews it before it appears. This does
          not change what your app can do: your OAuth client’s allowed scopes stay the limit.
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

              {/* The OG pull now auto-fires once a valid https URL is entered (blur,
                  Enter, Next, or a debounced pause) — no manual button. A subtle inline
                  status reports loading / applied / partial / empty / error. */}
              {autofill.loading && (
                <Group gap={6} data-testid="apps-offsite-meta-loading">
                  <Loader size={12} />
                  <Text size="xs" c="dimmed">
                    Looking for a name, description and images from your link…
                  </Text>
                </Group>
              )}
              {!autofill.loading && autofill.result?.status === 'error' && (
                <Text size="xs" c="red" data-testid="apps-offsite-submit-autofill-error">
                  Couldn’t read that site’s details — check the URL, or add your images and
                  description manually.
                </Text>
              )}
              {!autofill.loading && autofill.result?.status === 'empty' && (
                <Text size="xs" c="dimmed" data-testid="apps-offsite-submit-autofill-empty">
                  {autofill.result.siteExposedNothing ? (
                    <>
                      Your site didn’t expose a name, description, icon or cover to pull. Add them
                      to the page’s <Code>&lt;head&gt;</Code>, or add your details and images
                      manually on the next steps.
                    </>
                  ) : (
                    'Nothing new to pull — your details and assets are already set.'
                  )}
                </Text>
              )}
              {!autofill.loading && autofill.result?.status === 'partial' && (
                <Text size="xs" c="dimmed" data-testid="apps-offsite-submit-autofill-partial">
                  Pulled what your link exposed — {describeMissingChannels(autofill.result.missing)}{' '}
                  {(autofill.result.missing?.length ?? 0) > 1 ? 'were' : 'was'} not found; add{' '}
                  {(autofill.result.missing?.length ?? 0) > 1 ? 'those' : 'that'} manually. Check
                  the Details and Assets steps for what we found.
                </Text>
              )}
              {!autofill.loading && autofill.result?.status === 'applied' && (
                <Alert
                  color="grape"
                  variant="light"
                  icon={<IconSparkles size={16} />}
                  data-testid="apps-offsite-submit-autofill-applied"
                >
                  <Text size="sm">
                    Pulled the latest details from your link — check the Details step for the name
                    and description, and the Assets step for the suggested icon/cover.
                  </Text>
                </Alert>
              )}

              <Group justify="space-between">
                <Button
                  variant="default"
                  onClick={handleCancel}
                  disabled={busy}
                  data-testid="apps-offsite-wizard-cancel"
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
              {/* 🔴 "Your OAuth app" assumes prior knowledge. A developer listing a
                  standalone app may never have registered an OAuth client and has no
                  reason to know why listing needs one. Explain the RELATIONSHIP in
                  plain language, before the picker, rather than after a failure. */}
              <Text size="sm" c="dimmed" data-testid="apps-offsite-oauth-explainer">
                {OAUTH_REQUIREMENT_EXPLAINER}
              </Text>

              {isModerator ? (
                // MOD: async global search over ALL non-App-Block clients. Empty search
                // returns the mod's own clients (server default). Server does the
                // matching, so client-side Select filtering is disabled (`filter`
                // passthrough) — otherwise it would re-filter the label locally.
                <Select
                  label="OAuth app"
                  description="Search any developer’s OAuth client by app name, author username, or author ID. Leave empty to see your own."
                  placeholder="Search apps…"
                  searchable
                  searchValue={clientSearch}
                  onSearchChange={setClientSearch}
                  filter={({ options }) => options}
                  data={modClientOptions}
                  value={values.connectClientId}
                  onChange={handleSelectClient}
                  error={errors.connectClientId}
                  disabled={busy}
                  required
                  nothingFoundMessage={noClientsFoundMessage}
                  rightSection={modSearchQuery.isFetching ? <Loader size={14} /> : undefined}
                  data-testid="apps-offsite-client-search"
                />
              ) : eligibleClients.status === 'unknown' ? (
                <Group gap={8} data-testid="apps-offsite-clients-loading">
                  <Loader size={16} />
                  <Text size="sm" c="dimmed">
                    Loading your OAuth apps…
                  </Text>
                </Group>
              ) : clients.length === 0 ? (
                // 🔴 DEFENCE IN DEPTH, deliberately still reachable. The mode
                // selector now surfaces this prerequisite BEFORE any work, but a
                // client can be deleted mid-flow (or the selector's read can be
                // stale), so this must not become unreachable-by-construction.
                <Alert color="gray" variant="light" data-testid="apps-offsite-no-clients">
                  <Text size="sm">{NO_ELIGIBLE_CLIENTS_TEXT}</Text>
                </Alert>
              ) : (
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
              )}

              {/* Persistent create-client deeplink — both roles, every picker state. */}
              {createClientLink}

              {selectedClient && (
                <DerivedScopesDisclosure
                  requestedScopes={values.requestedScopes}
                  justifications={values.scopeJustifications}
                  onJustificationChange={handleJustificationChange}
                  disabled={busy}
                  forceShowErrors={showScopeErrors}
                />
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
            !submitted &&
            isCreateUrlStepComplete(values) &&
            isClientStepComplete(values, allowedScopes)
          }
          data-testid="apps-offsite-wizard-step-details"
        >
          <FadeIn>
            <Stack gap="md" mt="md">
              {autofill.applied && (
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
              {autofill.loading && (
                <Group gap={6} data-testid="apps-offsite-meta-loading">
                  <Loader size={12} />
                  <Text size="xs" c="dimmed">
                    Looking for a name, description and images from your link…
                  </Text>
                </Group>
              )}
              <TextInput
                label="Name"
                placeholder="My App"
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

              {/* Optional public source-repository link. Host list comes from the
                  SERVER allowlist (SOURCE_REPO_HOSTS_LABEL), never a second copy. */}
              <TextInput
                label="Source repository"
                description={`Public link to your app's source code, shown on its store page (optional). ${SOURCE_REPO_HOSTS_LABEL} only, linking to the repository itself.`}
                placeholder="https://github.com/your-org/your-app"
                value={values.sourceRepoUrl}
                onChange={(e) => setField('sourceRepoUrl', e.currentTarget.value)}
                onKeyDown={handleDetailsKeyDown}
                error={errors.sourceRepoUrl}
                maxLength={OFFSITE_SUBMIT_LIMITS.sourceRepoUrlMax}
                disabled={busy}
                data-testid="apps-offsite-submit-source-repo"
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
                suggestions={autofill.suggestions}
                onRepull={autofill.repull}
                repullLoading={autofill.loading}
                header={
                  <Alert
                    color="green"
                    variant="light"
                    icon={<IconCheck size={16} />}
                    title="Draft created"
                  >
                    <Text size="sm">
                      <Code>{submitted.slug}</Code> is a pending {STANDALONE_KIND_LABEL} submission.
                      Attach an icon and a cover below to be approved — screenshots are recommended
                      but optional and can be added later. Content rating:{' '}
                      <Badge size="xs">{offsiteContentRatingLabel(values.contentRating)}</Badge>
                    </Text>
                  </Alert>
                }
                footer={
                  <Group justify="flex-end">
                    <Button
                      component={Link}
                      href="/apps/mine"
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
