import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  FileInput,
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
  IconPhoto,
  IconRefresh,
  IconUpload,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
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
import {
  classifyAttachResult,
  shouldKeepPolling,
  type AttachOutcome,
} from '~/components/Apps/assetPolling';
import {
  appendScreenshotSlot,
  makeScreenshotSlotId,
  patchScreenshotSlot,
  type ScreenshotSlot,
} from '~/components/Apps/screenshotSlots';
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
 * DARK: reachable only behind `app-blocks-author` (the gSSP gate on /apps/submit is
 * unchanged; `deIndex` stays on). Nothing renders to real users until the store
 * segment widens.
 */

type Submitted = { listingId: string; publishRequestId: string; slug: string };

type AssetKind = 'icon' | 'cover' | 'screenshot';

/**
 * Per-asset attach lifecycle:
 *   idle      — nothing uploaded yet.
 *   working   — uploading + persisting, or the very first attach attempt.
 *   scanning  — the persisted image is still being virus/NSFW-scanned, so the P1
 *               attach proc rejected with "scan is not complete"; we AUTO-POLL the
 *               attach on a backoff (see `assetPolling.ts`) and flip to `attached`
 *               the moment the scan lands — no manual Retry needed.
 *   attached  — the attach succeeded (terminal).
 *   error     — the attach failed for a NON-scan reason (blocked / NSFW / bad
 *               dimensions); polling stops and the reason is shown (terminal).
 *   timeout   — the scan didn't complete within the ~3-min poll budget; polling
 *               stops but the manual Retry stays as a fallback.
 *
 * NOTE: on a PR PREVIEW the scanner is unreachable, so a real image will poll →
 * `timeout` (expected). The auto-poll is validated on PROD, where the scan
 * actually completes and the asset transitions scanning → attached on its own.
 */
type AssetStatus = 'idle' | 'working' | 'scanning' | 'attached' | 'timeout' | 'error';
type AssetState = {
  status: AssetStatus;
  imageId: number | null;
  message: string | null;
};

const emptyAsset: AssetState = { status: 'idle', imageId: null, message: null };

/**
 * A screenshot slot carries a STABLE per-file `id`. A multi-file batch is added in
 * one loop where the `screenshots` array closure is stale between iterations, so
 * capturing `screenshots.length` as the slot index collides (every file writes the
 * same slot). Patching by `id` instead fills distinct slots regardless of batching.
 * The pure slot-management logic (append / patch-by-id / id) lives in
 * `screenshotSlots.ts` so it is unit-testable without mounting the form.
 */
type ScreenshotState = ScreenshotSlot;

/** Read the intrinsic pixel dimensions of an image File (the P1 attach proc
 *  rejects unknown/zero dimensions, so they must accompany the persisted row). */
async function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

/** Wizard step indices — URL → Details → Assets. */
const STEP_URL = 0;
const STEP_DETAILS = 1;
const STEP_ASSETS = 2;

export function ExternalSubmitForm() {
  const [active, setActive] = useState<number>(STEP_URL);
  const [values, setValues] = useState<OffsiteSubmitFormValues>(emptyOffsiteSubmitForm());
  const [errors, setErrors] = useState<OffsiteSubmitFormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);

  const submitMutation = trpc.appListings.submitExternalListing.useMutation({
    onSuccess: (res: Submitted) => {
      setSubmitted(res);
      setServerError(null);
      setActive(STEP_ASSETS); // draft created — advance into the asset step
      showSuccessNotification({ message: 'Draft created. Add your assets to finish.' });
    },
    onError: (e: { message: string }) => {
      // The server owns validation; map its message inline (slug taken, bad URL,
      // mutual-exclusivity) rather than only a toast.
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

  /**
   * Store the canonical https URL and derive name + slug from it. The prefill is
   * NON-DESTRUCTIVE — only fills a currently-blank field, so a name/slug the author
   * already typed (or edited on the Details step) is never clobbered. `normalized`
   * is the already-validated https URL from `normalizeLinkUrl`, so the STORED /
   * submitted `externalUrl` is guaranteed https and the derivation runs on it.
   */
  function applyNormalizedUrl(normalized: string) {
    const derived = deriveListingFromUrl(normalized);
    setValues((v) => ({
      ...v,
      externalUrl: normalized,
      name: v.name.trim().length === 0 && derived.name ? derived.name : v.name,
      slug: v.slug.trim().length === 0 && derived.slug ? derived.slug : v.slug,
    }));
  }

  /**
   * URL-field blur: normalize (bare domain → https, host:port → https) and store
   * the canonical https value + prefill. GENTLE — an invalid URL (empty, explicit
   * `http://`, non-https scheme) is left as-is with NO inline error on blur; the
   * error only surfaces when the author tries to advance.
   */
  function handleUrlBlur() {
    const result = normalizeLinkUrl(values.externalUrl);
    if (result.error) return;
    applyNormalizedUrl(result.url);
    setErrors((prev) => ({ ...prev, externalUrl: undefined }));
  }

  /**
   * Advance URL → Details. Normalize + validate first: a bare domain is accepted
   * (upgraded to https and stored) so it no longer shows an error, but an explicit
   * `http://` (or any non-https scheme) is REJECTED inline and blocks the advance.
   */
  function handleAdvanceFromUrl() {
    const result = normalizeLinkUrl(values.externalUrl);
    if (result.error) {
      setErrors((prev) => ({ ...prev, externalUrl: result.error }));
      return;
    }
    applyNormalizedUrl(result.url);
    setErrors((prev) => ({ ...prev, externalUrl: undefined }));
    setActive(STEP_DETAILS);
  }

  /** Enter on the URL field advances the step (same normalize+validate as Next). */
  function handleUrlKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    handleAdvanceFromUrl();
  }

  /**
   * Enter on a Details text field creates the draft — but ONLY when the whole
   * Details step validates, guarding against an accidental empty submit. The
   * authoritative `validateOffsiteSubmitForm` still runs inside `handleCreateDraft`.
   */
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

  /**
   * Step-marker navigation. Once the draft is created (`submitted`) the earlier
   * steps are locked — the listing already exists server-side, so re-editing the
   * URL/details would be a lie. Before that, the URL step is always reachable and
   * the Details step is reachable once the URL validates. The Assets step is only
   * reachable via a successful submit (handled in `onSuccess`).
   */
  function handleStepClick(step: number) {
    if (submitted) return;
    if (step === STEP_URL) {
      setActive(STEP_URL);
      return;
    }
    if (step === STEP_DETAILS) {
      const result = normalizeLinkUrl(values.externalUrl);
      if (result.error) return; // can't reach Details with an invalid URL
      applyNormalizedUrl(result.url);
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
                // UX gate: the Details step must be complete before a draft can be
                // created. `handleCreateDraft` still runs the authoritative
                // `validateOffsiteSubmitForm` on click — this only disables the
                // button early so the Details→Assets gate is explicit in the UI.
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
              <AssetStep submitted={submitted} contentRating={values.contentRating} />
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

/**
 * Asset step: after the draft listing exists, attach an icon + cover + ≥1
 * screenshot via the standard CF media path + the P1 asset procs. Each asset is
 * upload → persist (`appListings.persistAssetImage`) → attach (setIcon/setCover/
 * addScreenshot). A newly-persisted image may still be scanning, so the attach can
 * return "scan is not complete" — the asset then shows a Retry.
 */
function AssetStep({
  submitted,
  contentRating,
}: {
  submitted: Submitted;
  contentRating: OffsiteContentRating;
}) {
  const { uploadToCF } = useCFImageUpload();
  const [icon, setIcon] = useState<AssetState>(emptyAsset);
  const [cover, setCover] = useState<AssetState>(emptyAsset);
  const [screenshots, setScreenshots] = useState<ScreenshotState[]>([]);
  const screenshotIdRef = useRef(0);

  const persistMutation = trpc.appListings.persistAssetImage.useMutation();
  const setIconMutation = trpc.appListings.setIcon.useMutation();
  const setCoverMutation = trpc.appListings.setCover.useMutation();
  const addScreenshotMutation = trpc.appListings.addScreenshot.useMutation();

  /**
   * Poll bookkeeping, keyed by asset ('icon' / 'cover' / a screenshot slot id):
   *   - `timers`  holds the ONE pending re-try timeout per asset (so a poll never
   *               stacks), cleared on success / error / timeout / retry / unmount.
   *   - `epochs`  is a per-asset generation counter; a new upload or manual Retry
   *               bumps it, and an in-flight poll cycle bails when its captured
   *               epoch is stale — so a Retry can't be raced by an older cycle.
   */
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const epochsRef = useRef<Map<string, number>>(new Map());

  function clearTimer(key: string) {
    const t = timersRef.current.get(key);
    if (t !== undefined) {
      clearTimeout(t);
      timersRef.current.delete(key);
    }
  }

  function bumpEpoch(key: string): number {
    const next = (epochsRef.current.get(key) ?? 0) + 1;
    epochsRef.current.set(key, next);
    return next;
  }

  function isCurrentEpoch(key: string, epoch: number): boolean {
    return (epochsRef.current.get(key) ?? 0) === epoch;
  }

  // Cancel every pending poll when the step unmounts (navigating away). This
  // covers "clear the timer on unmount / when leaving the step" — the earlier
  // wizard steps are locked once submitted, so unmount is the only exit.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  /** Upload → persist → return the persisted numeric imageId (throws on failure). */
  async function uploadAndPersist(file: File): Promise<number> {
    const { width, height } = await readImageDimensions(file);
    const result = await uploadToCF(file);
    const { imageId } = await persistMutation.mutateAsync({
      // `result.id` is the CF upload key (uuid) — imageSchema.url expects a uuid.
      url: result.id,
      name: file.name,
      width,
      height,
      mimeType: file.type || undefined,
      sizeBytes: file.size,
    });
    return imageId;
  }

  /** Run the attach proc once for an already-persisted imageId; classify the
   *  outcome (attached / scanning / non-scan error) with the pure helper. */
  async function attachOnce(kind: AssetKind, imageId: number): Promise<AttachOutcome> {
    try {
      if (kind === 'icon') {
        await setIconMutation.mutateAsync({ listingId: submitted.listingId, imageId });
      } else if (kind === 'cover') {
        await setCoverMutation.mutateAsync({ listingId: submitted.listingId, imageId });
      } else {
        await addScreenshotMutation.mutateAsync({ listingId: submitted.listingId, imageId });
      }
      return classifyAttachResult(null);
    } catch (err) {
      return classifyAttachResult((err as Error).message);
    }
  }

  /**
   * Drive one attach cycle for `key`: run the attach, then on
   *   attached → terminal 'attached';
   *   error    → terminal 'error' (show the reason, stop);
   *   scanning → if the backoff still has budget, show the spinner and schedule the
   *              next cycle; else terminal 'timeout' (manual Retry stays).
   * `attempt` is the 0-indexed re-try number (attempt 0 = the first attach). The
   * captured `epoch` guards against a superseding upload/Retry. On PR PREVIEW the
   * scanner is unreachable, so this cycles scanning → timeout (expected); on PROD
   * it lands scanning → attached.
   */
  async function drive(
    key: string,
    kind: AssetKind,
    imageId: number,
    attempt: number,
    epoch: number,
    apply: (s: AssetState) => void
  ) {
    const outcome = await attachOnce(kind, imageId);
    if (!isCurrentEpoch(key, epoch)) return; // superseded by a newer cycle
    if (outcome.kind === 'attached') {
      clearTimer(key);
      apply({ status: 'attached', imageId, message: null });
      return;
    }
    if (outcome.kind === 'error') {
      clearTimer(key);
      apply({ status: 'error', imageId, message: outcome.message });
      return;
    }
    const decision = shouldKeepPolling(outcome, attempt);
    if (!decision.keep) {
      clearTimer(key);
      apply({ status: 'timeout', imageId, message: 'Still scanning — Retry in a moment.' });
      return;
    }
    apply({ status: 'scanning', imageId, message: null });
    const timer = setTimeout(() => {
      void drive(key, kind, imageId, attempt + 1, epoch, apply);
    }, decision.delayMs);
    timersRef.current.set(key, timer);
  }

  /** Upload a fresh file then start the attach/poll cycle for `key`. */
  async function startAttach(
    key: string,
    kind: AssetKind,
    file: File | null,
    apply: (s: AssetState) => void
  ) {
    if (!file) return;
    clearTimer(key);
    const epoch = bumpEpoch(key);
    apply({ status: 'working', imageId: null, message: null });
    try {
      const imageId = await uploadAndPersist(file);
      if (!isCurrentEpoch(key, epoch)) return; // a newer upload/Retry superseded this
      await drive(key, kind, imageId, 0, epoch, apply);
    } catch (err) {
      if (!isCurrentEpoch(key, epoch)) return;
      clearTimer(key);
      apply({ status: 'error', imageId: null, message: (err as Error).message });
      showErrorNotification({ title: `Could not add ${kind}`, error: err as Error });
    }
  }

  /** Manual Retry: reset the poll (new epoch, cleared timer) and re-drive from the
   *  already-persisted imageId. */
  async function retryAttach(
    key: string,
    kind: AssetKind,
    imageId: number,
    apply: (s: AssetState) => void
  ) {
    clearTimer(key);
    const epoch = bumpEpoch(key);
    apply({ status: 'working', imageId, message: null });
    await drive(key, kind, imageId, 0, epoch, apply);
  }

  async function handleScreenshots(files: File[]) {
    for (const file of files) {
      // Reserve a slot with a STABLE id up-front, then patch THAT slot by id — the
      // `screenshots` closure is stale within this loop, so an index derived from
      // `screenshots.length` would collide across a multi-file batch. See
      // `screenshotSlots.ts` for the pure append/patch-by-id logic.
      const id = makeScreenshotSlotId(screenshotIdRef.current++);
      setScreenshots((prev: ScreenshotState[]) => appendScreenshotSlot(prev, id));
      await startAttach(id, 'screenshot', file, (s: AssetState) =>
        setScreenshots((prev: ScreenshotState[]) => patchScreenshotSlot(prev, id, s))
      );
    }
  }

  function retryScreenshot(id: string) {
    const state = screenshots.find((s: ScreenshotState) => s.id === id);
    if (!state || state.imageId == null) return;
    void retryAttach(id, 'screenshot', state.imageId, (s: AssetState) =>
      setScreenshots((prev: ScreenshotState[]) => patchScreenshotSlot(prev, id, s))
    );
  }

  const attachedScreenshots = screenshots.filter((s) => s.status === 'attached').length;
  const complete =
    icon.status === 'attached' && cover.status === 'attached' && attachedScreenshots >= 1;

  return (
    <Stack gap="md" data-testid="apps-offsite-submit-success">
      <Alert color="green" variant="light" icon={<IconCheck size={16} />} title="Draft created">
        <Text size="sm">
          <Code>{submitted.slug}</Code> is a pending off-site submission. Attach an icon, a cover
          and at least one screenshot below — a moderator can only approve an asset-complete
          listing. Content rating: <Badge size="xs">{contentRating}</Badge>
        </Text>
      </Alert>

      <AssetRow
        kind="icon"
        label="Icon"
        description="Square-ish, ≥128px, png/jpeg/webp."
        state={icon}
        onFile={(f) => void startAttach('icon', 'icon', f, setIcon)}
        onRetry={() => {
          if (icon.imageId != null) void retryAttach('icon', 'icon', icon.imageId, setIcon);
        }}
      />
      <AssetRow
        kind="cover"
        label="Cover"
        description="Landscape, ≥640px wide, png/jpeg/webp."
        state={cover}
        onFile={(f) => void startAttach('cover', 'cover', f, setCover)}
        onRetry={() => {
          if (cover.imageId != null) void retryAttach('cover', 'cover', cover.imageId, setCover);
        }}
      />

      <Card withBorder p="sm">
        <Stack gap="xs">
          <Group gap={6}>
            <IconPhoto size={16} />
            <Text size="sm" fw={600}>
              Screenshots
            </Text>
            <Badge size="xs" color={attachedScreenshots >= 1 ? 'green' : 'gray'}>
              {attachedScreenshots} attached
            </Badge>
          </Group>
          <FileInput
            label="Add screenshots"
            placeholder="Select one or more images"
            accept="image/png,image/jpeg,image/webp"
            multiple
            clearable
            leftSection={<IconUpload size={16} />}
            value={[]}
            onChange={(files: File[]) => void handleScreenshots(files)}
          />
          {screenshots.length > 0 && (
            <Stack gap={4}>
              {screenshots.map((s, i) => (
                <Group key={s.id} gap={8} justify="space-between">
                  <Text size="xs">Screenshot {i + 1}</Text>
                  <Group gap={6}>
                    <AssetStatusBadge state={s} />
                    {(s.status === 'error' || s.status === 'timeout') && s.imageId != null && (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        leftSection={<IconRefresh size={12} />}
                        onClick={() => retryScreenshot(s.id)}
                      >
                        Retry
                      </Button>
                    )}
                  </Group>
                </Group>
              ))}
            </Stack>
          )}
        </Stack>
      </Card>

      <Alert
        color={complete ? 'green' : 'yellow'}
        variant="light"
        icon={complete ? <IconCheck size={16} /> : <IconAlertTriangle size={16} />}
      >
        <Text size="sm">
          {complete
            ? 'All required assets attached. Your submission is ready for moderator review.'
            : 'A moderator can only approve once an icon, a cover and ≥1 screenshot are attached.'}
        </Text>
      </Alert>

      <Group justify="flex-end">
        <Button
          component={Link}
          href="/apps/my-submissions"
          rightSection={<IconExternalLink size={16} />}
        >
          View my submissions
        </Button>
      </Group>
    </Stack>
  );
}

function AssetRow({
  kind,
  label,
  description,
  state,
  onFile,
  onRetry,
}: {
  kind: AssetKind;
  label: string;
  description: string;
  state: AssetState;
  onFile: (file: File | null) => void;
  onRetry: () => void;
}) {
  return (
    <Card withBorder p="sm">
      <Stack gap="xs">
        <Group gap={6} justify="space-between">
          <Group gap={6}>
            <IconPhoto size={16} />
            <Text size="sm" fw={600}>
              {label}
            </Text>
          </Group>
          <Group gap={6}>
            <AssetStatusBadge state={state} />
            {(state.status === 'error' || state.status === 'timeout') && state.imageId != null && (
              <Button
                size="compact-xs"
                variant="subtle"
                leftSection={<IconRefresh size={12} />}
                onClick={onRetry}
              >
                Retry
              </Button>
            )}
          </Group>
        </Group>
        <FileInput
          label={`Upload ${kind}`}
          description={description}
          placeholder="Select an image"
          accept="image/png,image/jpeg,image/webp"
          clearable
          leftSection={<IconUpload size={16} />}
          value={null}
          onChange={onFile}
          disabled={state.status === 'working' || state.status === 'scanning'}
        />
        {state.message && (
          <Text size="xs" c={state.status === 'error' ? 'red' : 'dimmed'}>
            {state.message}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

// Accepts either an AssetState (icon/cover) or a ScreenshotSlot (screenshots) via
// the minimal shared shape — AssetStatus ⊆ ScreenshotSlotStatus, and no `id` is
// required so both structurally satisfy it. The legacy `processing` value is
// rendered like `scanning` (the component no longer produces it, but the shared
// ScreenshotSlot type still permits it).
type BadgeState = {
  status: ScreenshotSlot['status'];
  imageId: number | null;
  message: string | null;
};
function AssetStatusBadge({ state }: { state: BadgeState }) {
  switch (state.status) {
    case 'working':
      return (
        <Badge size="xs" color="blue" leftSection={<Loader size={10} color="blue" />}>
          uploading…
        </Badge>
      );
    case 'scanning':
    case 'processing':
      // Auto-poll in progress: spinner + "Scanning image…" (no Retry — it retries
      // itself on a backoff until the scan lands or the budget is spent).
      return (
        <Badge size="xs" color="yellow" leftSection={<Loader size={10} color="yellow" />}>
          Scanning image…
        </Badge>
      );
    case 'attached':
      return (
        <Badge size="xs" color="green" leftSection={<IconCheck size={10} />}>
          attached
        </Badge>
      );
    case 'timeout':
      return (
        <Badge size="xs" color="orange" leftSection={<IconAlertTriangle size={10} />}>
          still scanning
        </Badge>
      );
    case 'error':
      return (
        <Badge size="xs" color="red">
          error
        </Badge>
      );
    default:
      return (
        <Text size="xs" c="dimmed">
          none
        </Text>
      );
  }
}
