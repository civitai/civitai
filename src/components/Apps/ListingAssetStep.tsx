import { Alert, Badge, Button, Card, FileInput, Group, Image, Loader, Stack, Text } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconPhoto,
  IconRefresh,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import {
  classifyAttachResult,
  shouldKeepPolling,
  type AttachOutcome,
} from '~/components/Apps/assetPolling';
import type { ScanStatusCode } from '~/shared/constants/scan-status.constants';
import {
  appendScreenshotSlot,
  makeScreenshotSlotId,
  patchScreenshotSlot,
  type ScreenshotSlot,
} from '~/components/Apps/screenshotSlots';
import type { EditAsset, EditScreenshot } from '~/components/Apps/offsiteEditConfig';
import type { OffsiteContentRating } from '~/server/schema/blocks/offsite-listing.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * App Store Listings (W13) — the reusable listing ASSET step (icon / cover / ≥1
 * screenshot), shared by the CREATE wizard (`ExternalSubmitForm`) and the EDIT
 * wizard (`ExternalListingEditForm`). It operates on ANY `listingId` the caller
 * owns — a fresh draft (create), the listing itself (draft/pending edit), or a
 * SHADOW revision (approved edit) — via the owner-gated P1 asset procs
 * (`persistAssetImage`/`ingestAssetFromUrl` + `setIcon`/`setCover`/`addScreenshot`/
 * `removeScreenshot`), with per-asset scan-status polling. Each asset mutates
 * IMMEDIATELY (eager), so the wizard's primary action only commits the scalar
 * patch (+ submits the revision for an approved edit).
 *
 * EDIT mode prefills `initial` assets (rendered as already-attached, with a
 * thumbnail, replaceable — and screenshots removable when `allowRemove`).
 */

/** Server-suggested image URLs from the URL's page metadata (cover = og:image, icon = favicon/apple-touch). */
export type MetaSuggestions = { coverImageUrl?: string; iconImageUrl?: string };

type AssetKind = 'icon' | 'cover' | 'screenshot';

/** Per-asset attach lifecycle (see the create wizard's doc for the full state map). */
export type AssetStatus = 'idle' | 'working' | 'scanning' | 'attached' | 'timeout' | 'error';
export type AssetState = {
  status: AssetStatus;
  imageId: number | null;
  message: string | null;
  /** An edge-resolved preview URL for an already-attached (prefilled) asset. */
  previewUrl?: string | null;
};

export const emptyAsset: AssetState = { status: 'idle', imageId: null, message: null };

/** Seed an icon/cover AssetState from an edit-prefill asset (attached iff it has an imageId). */
function assetFromInitial(a: EditAsset | undefined): AssetState {
  if (!a || a.imageId == null) return emptyAsset;
  return { status: 'attached', imageId: a.imageId, message: null, previewUrl: a.url };
}

/** Read the intrinsic pixel dimensions of an image File (the attach proc rejects zero/unknown). */
async function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

export function ListingAssetStep({
  listingId,
  contentRating,
  suggestions,
  initial,
  header,
  footer,
  allowRemove = false,
  onAssetMutated,
}: {
  listingId: string;
  contentRating: OffsiteContentRating;
  suggestions: MetaSuggestions;
  /** Prefill (EDIT mode): current icon/cover/screenshots shown as already-attached. */
  initial?: { icon: EditAsset; cover: EditAsset; screenshots: EditScreenshot[] };
  /** Optional content above the asset rows (create shows a "draft created" alert). */
  header?: ReactNode;
  /** Optional content below the completeness alert (create shows a "view submissions" cta). */
  footer?: ReactNode;
  /** Enable removing screenshots (edit mode) via the owner-gated removeScreenshot proc. */
  allowRemove?: boolean;
  /** Called after any successful asset mutation (attach / remove) — edit mode uses
   *  it to know a revision has diverged from the live listing. */
  onAssetMutated?: () => void;
}) {
  const { uploadToCF } = useCFImageUpload();
  const [icon, setIcon] = useState<AssetState>(() => assetFromInitial(initial?.icon));
  const [cover, setCover] = useState<AssetState>(() => assetFromInitial(initial?.cover));
  const [screenshots, setScreenshots] = useState<ScreenshotSlot[]>(() =>
    (initial?.screenshots ?? [])
      .filter((s) => s.imageId != null)
      .map((s) => ({ id: `pre_${s.id}`, status: 'attached' as const, imageId: s.imageId, message: null }))
  );
  const screenshotIdRef = useRef(0);
  // Slot id → { rowId (AppListingScreenshot.id, for removal), previewUrl }. Kept
  // OUTSIDE the ScreenshotSlot (shared pure type) so the batch-slot helpers stay
  // narrow; seeded from the prefill and filled from addScreenshot's return.
  const [screenshotMeta, setScreenshotMeta] = useState<
    Record<string, { rowId: string | null; previewUrl: string | null }>
  >(() => {
    const seed: Record<string, { rowId: string | null; previewUrl: string | null }> = {};
    for (const s of initial?.screenshots ?? []) {
      if (s.imageId != null) seed[`pre_${s.id}`] = { rowId: s.id, previewUrl: s.url };
    }
    return seed;
  });

  const persistMutation = trpc.appListings.persistAssetImage.useMutation();
  const ingestMutation = trpc.appListings.ingestAssetFromUrl.useMutation();
  const setIconMutation = trpc.appListings.setIcon.useMutation();
  const setCoverMutation = trpc.appListings.setCover.useMutation();
  const addScreenshotMutation = trpc.appListings.addScreenshot.useMutation();
  const removeScreenshotMutation = trpc.appListings.removeScreenshot.useMutation();

  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const epochsRef = useRef<Map<string, number>>(new Map());
  // Slot key → the AppListingScreenshot row id returned by addScreenshot (so a
  // freshly-added screenshot is also removable). Prefilled rows use screenshotMeta.
  const rowIdRef = useRef<Map<string, string>>(new Map());

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

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  async function uploadAndPersist(file: File): Promise<number> {
    const { width, height } = await readImageDimensions(file);
    const result = await uploadToCF(file);
    const { imageId } = await persistMutation.mutateAsync({
      url: result.id,
      name: file.name,
      width,
      height,
      mimeType: file.type || undefined,
      sizeBytes: file.size,
    });
    return imageId;
  }

  async function attachOnce(key: string, kind: AssetKind, imageId: number): Promise<AttachOutcome> {
    try {
      if (kind === 'icon') {
        await setIconMutation.mutateAsync({ listingId, imageId });
      } else if (kind === 'cover') {
        await setCoverMutation.mutateAsync({ listingId, imageId });
      } else {
        const res = await addScreenshotMutation.mutateAsync({ listingId, imageId });
        // Capture the row id so a freshly-added screenshot is also removable.
        if (res && typeof (res as { id?: unknown }).id === 'string') {
          rowIdRef.current.set(key, (res as { id: string }).id);
        }
      }
      return classifyAttachResult(null);
    } catch (err) {
      // Extract the STRUCTURAL fields off the tRPC client error — the code and
      // the machine scanStatus token — NOT the prose. The message is passed
      // through for DISPLAY only. (See assetPolling.classifyAttachResult.)
      const data = (err as { data?: { code?: string; scanStatus?: ScanStatusCode } })?.data;
      return classifyAttachResult({
        code: data?.code,
        scanStatus: data?.scanStatus,
        message: (err as Error).message,
      });
    }
  }

  async function drive(
    key: string,
    kind: AssetKind,
    imageId: number,
    attempt: number,
    epoch: number,
    apply: (s: AssetState) => void
  ) {
    const outcome = await attachOnce(key, kind, imageId);
    if (!isCurrentEpoch(key, epoch)) return;
    if (outcome.kind === 'attached') {
      clearTimer(key);
      apply({ status: 'attached', imageId, message: null });
      // Promote a captured row id into screenshotMeta so the Remove button appears.
      const rowId = rowIdRef.current.get(key);
      if (rowId) {
        setScreenshotMeta((prev) => ({ ...prev, [key]: { rowId, previewUrl: prev[key]?.previewUrl ?? null } }));
      }
      onAssetMutated?.();
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
      if (!isCurrentEpoch(key, epoch)) return;
      await drive(key, kind, imageId, 0, epoch, apply);
    } catch (err) {
      if (!isCurrentEpoch(key, epoch)) return;
      clearTimer(key);
      apply({ status: 'error', imageId: null, message: (err as Error).message });
      showErrorNotification({ title: `Could not add ${kind}`, error: err as Error });
    }
  }

  async function acceptSuggestion(
    key: string,
    kind: 'icon' | 'cover',
    url: string,
    apply: (s: AssetState) => void
  ) {
    clearTimer(key);
    const epoch = bumpEpoch(key);
    apply({ status: 'working', imageId: null, message: null });
    try {
      const { imageId } = await ingestMutation.mutateAsync({ url, kind });
      if (!isCurrentEpoch(key, epoch)) return;
      await drive(key, kind, imageId, 0, epoch, apply);
    } catch (err) {
      if (!isCurrentEpoch(key, epoch)) return;
      clearTimer(key);
      apply({ status: 'error', imageId: null, message: (err as Error).message });
      showErrorNotification({ title: `Could not import ${kind}`, error: err as Error });
    }
  }

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
      const id = makeScreenshotSlotId(screenshotIdRef.current++);
      setScreenshots((prev) => appendScreenshotSlot(prev, id));
      await startAttach(id, 'screenshot', file, (s) =>
        setScreenshots((prev) => patchScreenshotSlot(prev, id, s))
      );
    }
  }

  function retryScreenshot(id: string) {
    const state = screenshots.find((s) => s.id === id);
    if (!state || state.imageId == null) return;
    void retryAttach(id, 'screenshot', state.imageId, (s) =>
      setScreenshots((prev) => patchScreenshotSlot(prev, id, s))
    );
  }

  async function removeScreenshot(id: string) {
    const rowId = screenshotMeta[id]?.rowId ?? rowIdRef.current.get(id) ?? null;
    // Optimistically drop the slot; if the server delete fails, surface it and
    // restore is not needed (the row still exists — a reload re-shows it).
    clearTimer(id);
    if (rowId) {
      try {
        await removeScreenshotMutation.mutateAsync({ screenshotId: rowId });
      } catch (err) {
        showErrorNotification({ title: 'Could not remove screenshot', error: err as Error });
        return;
      }
    }
    setScreenshots((prev) => prev.filter((s) => s.id !== id));
    setScreenshotMeta((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    rowIdRef.current.delete(id);
    onAssetMutated?.();
  }

  const attachedScreenshots = screenshots.filter((s) => s.status === 'attached').length;
  const complete =
    icon.status === 'attached' && cover.status === 'attached' && attachedScreenshots >= 1;

  return (
    <Stack gap="md" data-testid="apps-offsite-submit-success">
      {header}

      <AssetRow
        kind="icon"
        label="Icon"
        description="Square-ish, ≥128px, png/jpeg/webp."
        state={icon}
        onFile={(f) => void startAttach('icon', 'icon', f, setIcon)}
        onRetry={() => {
          if (icon.imageId != null) void retryAttach('icon', 'icon', icon.imageId, setIcon);
        }}
        suggestionUrl={suggestions.iconImageUrl}
        onAcceptSuggestion={() => {
          if (suggestions.iconImageUrl)
            void acceptSuggestion('icon', 'icon', suggestions.iconImageUrl, setIcon);
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
        suggestionUrl={suggestions.coverImageUrl}
        onAcceptSuggestion={() => {
          if (suggestions.coverImageUrl)
            void acceptSuggestion('cover', 'cover', suggestions.coverImageUrl, setCover);
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
              {screenshots.map((s, i) => {
                const previewUrl = screenshotMeta[s.id]?.previewUrl ?? null;
                const removable =
                  allowRemove && (screenshotMeta[s.id]?.rowId != null || rowIdRef.current.has(s.id));
                return (
                  <Group key={s.id} gap={8} justify="space-between">
                    <Group gap={8}>
                      {previewUrl && (
                        <Image src={previewUrl} w={40} h={28} radius="sm" fit="cover" alt="" />
                      )}
                      <Text size="xs">Screenshot {i + 1}</Text>
                    </Group>
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
                      {removable && (
                        <Button
                          size="compact-xs"
                          variant="subtle"
                          color="red"
                          leftSection={<IconTrash size={12} />}
                          onClick={() => void removeScreenshot(s.id)}
                          data-testid={`apps-offsite-screenshot-remove-${i}`}
                        >
                          Remove
                        </Button>
                      )}
                    </Group>
                  </Group>
                );
              })}
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

      {footer}
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
  suggestionUrl,
  onAcceptSuggestion,
}: {
  kind: AssetKind;
  label: string;
  description: string;
  state: AssetState;
  onFile: (file: File | null) => void;
  onRetry: () => void;
  suggestionUrl?: string;
  onAcceptSuggestion?: () => void;
}) {
  const showSuggestion = state.status === 'idle' && !!suggestionUrl && !!onAcceptSuggestion;
  const showPreview = state.status === 'attached' && !!state.previewUrl;
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
        {showPreview && (
          <Image
            src={state.previewUrl ?? undefined}
            w={kind === 'icon' ? 48 : 120}
            h={kind === 'icon' ? 48 : 68}
            radius="sm"
            fit="contain"
            alt={`current ${kind}`}
            data-testid={`apps-offsite-current-${kind}-preview`}
          />
        )}
        {showSuggestion && (
          <Card withBorder p="xs" bg="var(--mantine-color-blue-light)">
            <Group gap="sm" wrap="nowrap">
              <Image
                src={suggestionUrl}
                w={48}
                h={48}
                radius="sm"
                fit="contain"
                alt={`suggested ${kind}`}
                data-testid={`apps-offsite-suggested-${kind}-preview`}
              />
              <Stack gap={2} style={{ flex: 1 }}>
                <Text size="xs" fw={600}>
                  Suggested from your link
                </Text>
                <Text size="xs" c="dimmed">
                  We&apos;ll re-scan it just like an upload.
                </Text>
              </Stack>
              <Button
                size="compact-xs"
                variant="light"
                leftSection={<IconCheck size={12} />}
                onClick={onAcceptSuggestion}
                data-testid={`apps-offsite-accept-${kind}`}
              >
                Use this
              </Button>
            </Group>
          </Card>
        )}
        <FileInput
          label={
            showPreview
              ? `Replace ${kind}`
              : showSuggestion
              ? `Or upload your own ${kind}`
              : `Upload ${kind}`
          }
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
