import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Modal,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconAdjustmentsAlt,
  IconAlertTriangle,
  IconCheck,
  IconCode,
  IconExternalLink,
  IconInfoCircle,
  IconKey,
  IconLayoutGrid,
  IconShieldLock,
  IconWindow,
  IconX,
} from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { ReviewBlockPreviewHost } from '~/components/Apps/ReviewBlockPreviewHost';
import { SensitiveScopeBadge } from '~/components/Apps/SensitiveScopeBadge';
import { useReviewPreview } from '~/components/Apps/useReviewPreview';
import {
  FileDiffEntry,
  FileListPreview,
  ManifestDiffPreview,
  type FileLineDiff,
} from '~/components/Apps/reviewDiffPanels';
import {
  ReasonGatedField,
  ReasonGatedSubmitButton,
  reasonMeetsMin,
} from '~/components/Apps/ReasonGatedActionModal';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isSensitiveBlockScope } from '~/shared/constants/block-scope.constants';
import { OFFSITE_MOD_REASON_MIN } from '~/server/schema/blocks/offsite-moderation.schema';
import {
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_CATEGORY_LABELS,
  type MarketplaceCategory,
} from '~/server/services/blocks/marketplace-categories.constants';
import {
  SCOPE_DESCRIPTIONS,
  SLOT_DESCRIPTIONS,
} from '~/server/services/blocks/scope-descriptions.constants';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * On-site (App Block) moderator review modal — extracted from `src/pages/apps/review.tsx`
 * so it (and its manifest/diff/preview sub-panels) can be imported into a browser
 * (jsdom) test WITHOUT pulling the page's `getServerSideProps`/`createServerSideProps`
 * tRPC-server graph. This mirrors the #3154 extraction of the diff panels to
 * `reviewDiffPanels.tsx` for the same reason. The sibling off-site modal is
 * `OffsiteReviewModal` in `OffsiteReviewQueue.tsx`.
 *
 * Everything here is server-graph-free: the only `~/server/...` imports are pure
 * constant tables (`scope-descriptions.constants`, `marketplace-categories.constants`)
 * and a zod-only schema (`offsite-moderation.schema`) — none touch Prisma/tRPC server
 * code. `review.tsx` imports these types/helpers + `OnsiteReviewModal` back and mounts
 * it exactly as before (zero behaviour change).
 */

export type ManifestDiffSummary =
  | { kind: 'first-version'; fields: string[] }
  | {
      kind: 'update';
      added: string[];
      removed: string[];
      changed: Array<{ field: string; from: unknown; to: unknown }>;
    };

export type FileSummary = {
  files: Array<{ path: string; sha256: string; sizeBytes: number }>;
  added: string[];
  removed: string[];
  changed: string[];
};

export type UserProfile = { id: number; username: string | null; image: string | null };

export type ReviewedRequestCommon = {
  id: string;
  appBlockId: string | null;
  slug: string;
  version: string;
  submittedAt: string | Date;
  bundleSizeBytes: string;
  bundleSha256: string;
  manifest: unknown;
  fileSummary: unknown;
  manifestDiffSummary: unknown;
  reviewRepoUrl: string;
  // PUSH-ORIGINATED requests (git-push, empty bundle) have no review-org
  // snapshot — this links the mod to the canonical repo at the exact pushed sha.
  pushCommitUrl?: string | null;
  submittedBy: UserProfile;
};

export type PendingRequest = ReviewedRequestCommon;

export type ApprovedRequest = ReviewedRequestCommon & {
  reviewedAt: string | Date | null;
  approvalNotes: string | null;
  reviewedBy: UserProfile | null;
};

export type RejectedRequest = ReviewedRequestCommon & {
  reviewedAt: string | Date | null;
  rejectionReason: string | null;
  reviewedBy: UserProfile | null;
};

export type AnyRequest = PendingRequest | ApprovedRequest | RejectedRequest;

/** The review-modal display mode. Structurally identical to the review page's
 *  `TabValue` (they share the same literal union), so the page's `selected.mode`
 *  is assignable to this without importing from the page module. */
export type OnsiteReviewMode = 'pending' | 'approved' | 'rejected' | 'reports';

export type OnsiteReviewSelection = { request: AnyRequest; mode: OnsiteReviewMode } | null;

export function formatBytes(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString();
}

// ---------------------------------------------------------------------------
// Review modal — pending requests get the interactive approve/reject UI;
// history requests get a read-only view with the mod feedback surfaced
// prominently.
// ---------------------------------------------------------------------------

/**
 * Thin outer shell. Owns the Mantine `<Modal>` (kept mounted + `opened`-toggled
 * so open/close still animates and doesn't flash) and derives only the static,
 * per-request title from `selection`. The interactive body — which holds the
 * transient approve/reject UI state — is rendered as a SEPARATE component keyed
 * on `selection.request.id` so it REMOUNTS whenever a different request is
 * selected. That remount is what deterministically resets `approvalNotes` /
 * `rejectionReason` / `actionMode` per request: previously this state lived on
 * one long-lived component that only swapped its `selection` prop, so switching
 * from one app to another leaked the prior app's reject-mode + reason text (a
 * mod who clicked "Reject…" on app A then opened app B saw B stuck in reject
 * mode with A's reason). Keying here means no caller has to remember to key it.
 */
export function OnsiteReviewModal({
  selection,
  onClose,
}: {
  selection: OnsiteReviewSelection;
  onClose: () => void;
}) {
  // Set by the body while an approve/reject mutation is in flight so this shell's
  // onClose (Escape / overlay click / the X) refuses to close mid-action — the
  // same guard the pre-split modal had inline. Written by the body during its
  // render; only read here in the (post-commit) close handler, so the value is
  // always current by the time a close is triggered.
  const busyRef = useRef(false);

  return (
    <Modal
      opened={!!selection}
      onClose={() => {
        if (busyRef.current) return;
        onClose();
      }}
      title={selection ? <OnsiteReviewModalTitle selection={selection} /> : null}
      size="xl"
      centered
    >
      {selection && (
        <OnsiteReviewModalBody
          key={selection.request.id}
          selection={selection}
          onClose={onClose}
          busyRef={busyRef}
        />
      )}
    </Modal>
  );
}

/** Static, per-request modal title (slug + version + a mode/first-version badge).
 *  Derived purely from `selection` — no transient state — so it lives on the
 *  stable shell, not the keyed body. */
function OnsiteReviewModalTitle({ selection }: { selection: NonNullable<OnsiteReviewSelection> }) {
  const { request, mode } = selection;
  const mds = (request.manifestDiffSummary ?? {}) as ManifestDiffSummary;
  return (
    <Group gap={6}>
      <Text fw={600}>{request.slug}</Text>
      <Code>{request.version}</Code>
      {mds.kind === 'first-version' && (
        <Badge color="violet" size="sm">
          first version
        </Badge>
      )}
      {mode === 'approved' && (
        <Badge color="green" size="sm">
          approved
        </Badge>
      )}
      {mode === 'rejected' && (
        <Badge color="red" size="sm">
          rejected
        </Badge>
      )}
    </Group>
  );
}

/**
 * Interactive review body. Holds the transient approve/reject UI state
 * (`approvalNotes` / `rejectionReason` / `actionMode`) plus the approve/reject
 * mutations. The parent keys this on `selection.request.id`, so all of that
 * state is fresh on every request switch — no manual reset needed, and the
 * `onSuccess → onClose` paths are safe because the next open remounts fresh.
 */
function OnsiteReviewModalBody({
  selection,
  onClose,
  busyRef,
}: {
  selection: NonNullable<OnsiteReviewSelection>;
  onClose: () => void;
  busyRef: { current: boolean };
}) {
  const utils = trpc.useUtils();
  const [approvalNotes, setApprovalNotes] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [actionMode, setActionMode] = useState<'view' | 'reject'>('view');

  const { request, mode } = selection;

  const approveMut = trpc.blocks.approveRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({
        message: `Approved ${request.slug} v${request.version}. Build started.`,
      });
      await utils.blocks.listPendingRequests.invalidate();
      await utils.blocks.listApprovedRequests.invalidate();
      onClose();
    },
    onError: (e) => {
      showErrorNotification({
        title: 'Approve failed',
        error: new Error(e.message),
      });
    },
  });
  const rejectMut = trpc.blocks.rejectRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({
        message: `Rejected ${request.slug} v${request.version}.`,
      });
      await utils.blocks.listPendingRequests.invalidate();
      await utils.blocks.listRejectedRequests.invalidate();
      onClose();
    },
    onError: (e) => {
      showErrorNotification({
        title: 'Reject failed',
        error: new Error(e.message),
      });
    },
  });

  const readOnly = mode !== 'pending';

  const manifest = request.manifest as Record<string, unknown>;
  const fs = (request.fileSummary ?? {}) as FileSummary;
  const mds = (request.manifestDiffSummary ?? {}) as ManifestDiffSummary;
  const busy = approveMut.isPending || rejectMut.isPending;
  // Publish the in-flight state up to the shell so its onClose can guard on it.
  busyRef.current = busy;

  const approved = mode === 'approved' ? (request as ApprovedRequest) : null;
  const rejected = mode === 'rejected' ? (request as RejectedRequest) : null;

  return (
    <Stack gap="md">
        <Group gap="xs" align="flex-start">
          <Text size="xs" c="dimmed">
            Submitter:
          </Text>
          <Text size="xs">
            {request.submittedBy.username ?? `#${request.submittedBy.id}`}
          </Text>
          <Text size="xs" c="dimmed">
            ·
          </Text>
          <Text size="xs" c="dimmed">
            {formatDate(request.submittedAt)}
          </Text>
          <Text size="xs" c="dimmed">
            · {formatBytes(request.bundleSizeBytes)}
          </Text>
        </Group>

        {(approved || rejected) && (
          <Alert
            color={approved ? 'green' : 'red'}
            variant="light"
            icon={approved ? <IconCheck size={16} /> : <IconX size={16} />}
            title={
              <Group gap={6}>
                <Text size="sm" fw={600}>
                  {approved ? 'Approved by' : 'Rejected by'}{' '}
                  {(approved ?? rejected)?.reviewedBy
                    ? (approved ?? rejected)!.reviewedBy!.username
                      ? `@${(approved ?? rejected)!.reviewedBy!.username}`
                      : `#${(approved ?? rejected)!.reviewedBy!.id}`
                    : 'unknown'}
                </Text>
                <Text size="xs" c="dimmed">
                  · {formatDate((approved ?? rejected)!.reviewedAt)}
                </Text>
              </Group>
            }
          >
            {approved && approved.approvalNotes && (
              <Stack gap={2}>
                <Text size="xs" c="dimmed">
                  Approval notes
                </Text>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {approved.approvalNotes}
                </Text>
              </Stack>
            )}
            {approved && !approved.approvalNotes && (
              <Text size="xs" c="dimmed" fs="italic">
                No approval notes were recorded.
              </Text>
            )}
            {rejected && rejected.rejectionReason && (
              <Stack gap={2}>
                <Text size="xs" c="dimmed">
                  Rejection reason
                </Text>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {rejected.rejectionReason}
                </Text>
              </Stack>
            )}
          </Alert>
        )}

        {/* MOD REVIEW SANDBOX (#2831) — run the PENDING version in a temporary,
            mod-gated preview before approving. Pending requests only; dark
            unless the mod-only review-sandbox flag is enabled. */}
        {mode === 'pending' && <ReviewPreviewPanel publishRequestId={request.id} slug={request.slug} />}

        {/* F-E E5 — publisher screenshot gallery review. Publisher-supplied
            images are an abuse vector → the mod sees them (here, derived from
            the submitted bundle) before approving. Renders for every mode so an
            approved app's screenshots can be re-checked too. */}
        <ScreenshotsReviewPanel publishRequestId={request.id} />

        {/* F-E E4 curation — marketplace metadata (category / featured / order).
            Only for an APPROVED request that has a linked app_block: featuring
            is approved-only, and the meta lives on the app_block row. */}
        {mode === 'approved' && request.appBlockId && (
          <CurationPanel key={request.appBlockId} appBlockId={request.appBlockId} />
        )}

        <Stack gap={4}>
          <Text size="sm" fw={600}>
            Files
          </Text>
          <Group gap={6}>
            <Text size="sm">{fs.files?.length ?? 0} total</Text>
            {(fs.added?.length ?? 0) > 0 && (
              <Badge color="green" variant="light">
                +{fs.added.length} added
              </Badge>
            )}
            {(fs.changed?.length ?? 0) > 0 && (
              <Badge color="yellow" variant="light">
                ~{fs.changed.length} changed
              </Badge>
            )}
            {(fs.removed?.length ?? 0) > 0 && (
              <Badge color="red" variant="light">
                −{fs.removed.length} removed
              </Badge>
            )}
          </Group>
          <Button
            component="a"
            href={request.pushCommitUrl ?? request.reviewRepoUrl}
            target="_blank"
            rel="noopener"
            variant="default"
            leftSection={<IconCode size={14} />}
            rightSection={<IconExternalLink size={12} />}
          >
            View full source
          </Button>
          {mds.kind === 'update' && (
            <FileListPreview added={fs.added} removed={fs.removed} changed={fs.changed} />
          )}
          {/* Line-level code diff — lazy (only fetched when the mod toggles it
              open) so the modal stays light by default. Bounded server-side;
              binary / oversized / huge-diff files fall back to the Forgejo link
              above. */}
          <CodeDiffPanel
            publishRequestId={request.id}
            forgejoUrl={request.pushCommitUrl ?? request.reviewRepoUrl}
          />
        </Stack>

        <Stack gap={4}>
          <Text size="sm" fw={600}>
            Manifest diff
          </Text>
          {mds.kind === 'first-version' ? (
            <Text size="xs" c="dimmed">
              First version — full manifest below.
            </Text>
          ) : (
            <ManifestDiffPreview diff={mds} />
          )}
        </Stack>

        <Stack gap={4}>
          <Text size="sm" fw={600}>
            Manifest
          </Text>
          <ManifestView manifest={manifest} />
        </Stack>

        {readOnly ? null : actionMode === 'reject' ? (
          <Stack gap="xs">
            <ReasonGatedField
              value={rejectionReason}
              onChange={setRejectionReason}
              disabled={busy}
              label="Rejection reason"
              placeholder={`Explain what needs to change before this can be approved (≥${OFFSITE_MOD_REASON_MIN} chars, shown to the dev).`}
              testId="apps-review-reject-reason"
              minRows={3}
              maxRows={10}
            />
            <Group justify="flex-end" gap="xs">
              <Button variant="default" onClick={() => setActionMode('view')} disabled={busy}>
                Cancel
              </Button>
              <ReasonGatedSubmitButton
                onClick={() =>
                  rejectMut.mutate({
                    publishRequestId: request.id,
                    rejectionReason: rejectionReason.trim(),
                  })
                }
                gateOpen={reasonMeetsMin(rejectionReason)}
                busy={rejectMut.isPending}
                color="red"
                leftSection={<IconX size={14} />}
                label="Reject"
                testId="apps-review-reject-confirm"
              />
            </Group>
          </Stack>
        ) : (
          <Stack gap="xs">
            <Textarea
              label="Approval notes (optional)"
              autosize
              minRows={2}
              maxRows={6}
              placeholder="Optional notes attached to the approval record."
              value={approvalNotes}
              onChange={(e) => setApprovalNotes(e.currentTarget.value)}
              disabled={busy}
            />
            <Group justify="flex-end" gap="xs">
              <Button
                color="red"
                variant="default"
                leftSection={<IconX size={14} />}
                onClick={() => setActionMode('reject')}
                disabled={busy}
              >
                Reject…
              </Button>
              <Button
                color="green"
                leftSection={<IconCheck size={14} />}
                onClick={() =>
                  approveMut.mutate({
                    publishRequestId: request.id,
                    approvalNotes: approvalNotes.trim() || undefined,
                  })
                }
                disabled={busy}
                loading={approveMut.isPending}
              >
                Approve + build
              </Button>
            </Group>
          </Stack>
        )}
      </Stack>
  );
}

// ---------------------------------------------------------------------------
// MOD REVIEW SANDBOX (#2831) — run a PENDING version in a temporary, mod-gated
// preview before approving. The Preview button starts a review build via
// blocks.previewRequest, then polls blocks.getReviewStatus (preview-building →
// deploying → live | failed) and, once live, embeds the review host in an
// iframe + offers a deep-link. The whole feature is dark behind the mod-only
// `app-blocks-review-sandbox` flag — when it's off, previewRequest throws
// UNAUTHORIZED and the panel surfaces a "not enabled" message instead.
// ---------------------------------------------------------------------------

function ReviewPreviewPanel({
  publishRequestId,
  slug,
}: {
  publishRequestId: string;
  slug: string;
}) {
  const utils = trpc.useUtils();

  // Shared live-preview poll + iframe-src stabilization (extracted verbatim to
  // `useReviewPreview` so this in-modal preview and the full-page preview route
  // stay behaviourally identical).
  const { state, detail, isLive, inProgress, isFailed, stableIframeSrc, error } =
    useReviewPreview(publishRequestId);

  const previewMut = trpc.blocks.previewRequest.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: `Review build started for ${slug}.` });
      await utils.blocks.getReviewStatus.invalidate({ publishRequestId });
    },
    onError: (e) => {
      showErrorNotification({ title: 'Could not start preview', error: new Error(e.message) });
    },
  });

  const teardownMut = trpc.blocks.teardownPreview.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: `Review preview torn down for ${slug}.` });
      // Clears the DB preview state → getReviewStatus returns state:null and the
      // panel reverts to "Start preview". Also refresh the global panel's count.
      await Promise.all([
        utils.blocks.getReviewStatus.invalidate({ publishRequestId }),
        utils.blocks.listActivePreviews.invalidate(),
      ]);
    },
    onError: (e) => {
      showErrorNotification({ title: 'Could not tear down preview', error: new Error(e.message) });
    },
  });

  return (
    <Stack gap={4}>
      <Group gap={6}>
        <IconWindow size={14} />
        <Text size="sm" fw={600}>
          Review preview
        </Text>
        {state && (
          <Badge
            size="sm"
            variant="light"
            color={isLive ? 'green' : isFailed ? 'red' : 'blue'}
          >
            {state.replace('preview-', '')}
          </Badge>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        Run this pending version in a temporary, mod-only preview before approving.
        Torn down automatically when you approve or reject.
      </Text>

      <Group gap="xs">
        <Button
          size="xs"
          variant="light"
          leftSection={<IconWindow size={14} />}
          loading={previewMut.isPending}
          disabled={previewMut.isPending || inProgress}
          onClick={() => previewMut.mutate({ publishRequestId })}
        >
          {state ? 'Rebuild preview' : 'Start preview'}
        </Button>
        {isLive && (
          // Full-page preview on a SAME-ORIGIN internal route that mounts the same
          // review host bridge at full viewport — opened top-level, so the mod
          // reviews the app "as the user would see it" while keeping this modal
          // open. It links by publishRequestId (NOT the raw `?mr=` host URL): that
          // raw URL is broken opened top-level — it has no host bridge, so the SDK
          // block hangs on "Connecting to host" (the bug #3172 fixed for the iframe).
          <Button
            size="xs"
            variant="default"
            component="a"
            href={`/apps/review/preview/${publishRequestId}`}
            target="_blank"
            rel="noopener"
            rightSection={<IconExternalLink size={12} />}
          >
            Open full-page preview ↗
          </Button>
        )}
        {state && (
          // Shown for every non-null preview state INCLUDING preview-failed:
          // teardownPreview clears any deploy_state that starts with `preview-`
          // back to null, so a FAILED preview can be dismissed to "Start preview"
          // (not just rebuilt). Label reflects that a failed row has nothing live
          // to tear down — it's a dismiss.
          <Button
            size="xs"
            variant="light"
            color="red"
            leftSection={<IconX size={12} />}
            loading={teardownMut.isPending}
            disabled={teardownMut.isPending}
            onClick={() => teardownMut.mutate({ publishRequestId })}
          >
            {isFailed ? 'Dismiss failed preview' : 'Tear down preview'}
          </Button>
        )}
      </Group>

      {inProgress && (
        <Text size="xs" c="dimmed">
          Building + deploying the review preview…
          {detail?.sha ? ` (sha ${detail.sha.slice(0, 12)})` : ''}
        </Text>
      )}
      {isFailed && (
        <Alert color="red" variant="light" icon={<IconX size={14} />}>
          {detail?.error ?? 'Review preview failed.'}
        </Alert>
      )}
      {isLive && stableIframeSrc && (
        // Mount the REAL PageBlockHost (via ReviewBlockPreviewHost) instead of a
        // raw <iframe>: the bug was that a raw iframe had NO host bridge, so
        // nothing posted BLOCK_INIT and the SDK block hung on "Connecting to host".
        // The host mints a self-bound, scope-stripped block token, forces
        // trustTier:'unverified' (opaque origin — drops allow-same-origin), and
        // runs reviewMode (read-only NACKs). The `?mr=` entry-token URL keeps its
        // pickReviewIframeSrc stabilization here; PageBlockHost's own iframe sets
        // referrerPolicy="no-referrer" so the entry token never leaks via Referer.
        <div
          style={{
            width: '100%',
            height: 420,
            border: '1px solid var(--mantine-color-default-border)',
            borderRadius: 6,
            overflow: 'hidden',
          }}
        >
          <ReviewBlockPreviewHost
            publishRequestId={publishRequestId}
            slug={slug}
            iframeSrc={stableIframeSrc}
          />
        </div>
      )}
      {error && (
        <Text size="xs" c="dimmed">
          {error.message}
        </Text>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// F-E E5 screenshot review panel — surfaces the publisher-supplied screenshots
// auto-discovered from the submitted bundle so the mod reviews them before
// approval (publisher images = abuse vector). Renders <img> from base64 data
// URLs returned by the mod-only blocks.getPublishRequestScreenshots query (the
// pending app has no public screenshot URL yet — it isn't approved).
// ---------------------------------------------------------------------------

function ScreenshotsReviewPanel({ publishRequestId }: { publishRequestId: string }) {
  const features = useFeatureFlags();
  const { data, isLoading, error } = trpc.blocks.getPublishRequestScreenshots.useQuery(
    { publishRequestId },
    { enabled: !!features?.appBlocks, retry: false }
  );
  const items = data?.items ?? [];

  return (
    <Stack gap={4}>
      <Group gap={6}>
        <IconLayoutGrid size={14} />
        <Text size="sm" fw={600}>
          Screenshots
        </Text>
        {!isLoading && !error && (
          <Badge size="sm" variant="light" color={items.length > 0 ? 'blue' : 'gray'}>
            {items.length}
          </Badge>
        )}
      </Group>
      {isLoading ? (
        <Text size="xs" c="dimmed">
          Loading screenshots from the submitted bundle…
        </Text>
      ) : error ? (
        <Text size="xs" c="red">
          Could not load screenshots: {error.message}
        </Text>
      ) : items.length === 0 ? (
        <Text size="xs" c="dimmed">
          This bundle includes no `screenshots/` directory.
        </Text>
      ) : (
        <>
          <Text size="xs" c="dimmed">
            Publisher-supplied images from the bundle — review before approving.
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            {items.map((shot) => (
              <Card key={shot.index} withBorder padding={0} radius="md" style={{ overflow: 'hidden' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={shot.dataUrl}
                  alt={`Screenshot ${shot.index + 1}`}
                  loading="lazy"
                  style={{ width: '100%', height: 'auto', display: 'block' }}
                />
              </Card>
            ))}
          </SimpleGrid>
        </>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// F-E E4 curation panel — mod controls to set the marketplace category +
// featured/order on an approved app_block (calls blocks.setMarketplaceMeta).
// Mod-only (the trPC procedures are moderatorProcedure-gated; the whole review
// page already requires isModerator).
// ---------------------------------------------------------------------------

const CATEGORY_SELECT_DATA = MARKETPLACE_CATEGORIES.map((c) => ({
  value: c,
  label: MARKETPLACE_CATEGORY_LABELS[c],
}));

function CurationPanel({ appBlockId }: { appBlockId: string }) {
  const features = useFeatureFlags();
  const utils = trpc.useUtils();
  const metaQuery = trpc.blocks.getMarketplaceMeta.useQuery(
    { appBlockId },
    { enabled: !!features?.appBlocks }
  );

  // Local form state, seeded from the fetched meta. `dirty` becomes true once
  // the mod edits a field so Save is only enabled when there's a change.
  const [category, setCategory] = useState<MarketplaceCategory | null>(null);
  const [featured, setFeatured] = useState(false);
  const [featuredOrder, setFeaturedOrder] = useState<number | null>(null);
  const [seeded, setSeeded] = useState(false);

  const meta = metaQuery.data;
  // Seed once when the query first resolves (and re-seed if a different app's
  // meta arrives — keyed on appBlockId via the parent remount, but guard here
  // too in case the panel is reused).
  if (meta && !seeded) {
    setCategory(
      meta.category && (MARKETPLACE_CATEGORIES as readonly string[]).includes(meta.category)
        ? (meta.category as MarketplaceCategory)
        : null
    );
    setFeatured(meta.featured);
    setFeaturedOrder(meta.featuredOrder);
    setSeeded(true);
  }

  const saveMut = trpc.blocks.setMarketplaceMeta.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Marketplace metadata saved.' });
      await utils.blocks.getMarketplaceMeta.invalidate({ appBlockId });
      await utils.blocks.getFeaturedBlocks.invalidate();
      await utils.blocks.listAvailable.invalidate();
    },
    onError: (e) => {
      showErrorNotification({ title: 'Save failed', error: new Error(e.message) });
    },
  });

  const isApproved = meta?.status === 'approved';
  const busy = saveMut.isPending;

  const dirty =
    !!meta &&
    ((category ?? null) !== (meta.category ?? null) ||
      featured !== meta.featured ||
      (featuredOrder ?? null) !== (meta.featuredOrder ?? null));

  return (
    <Card withBorder p="sm">
      <Stack gap="sm">
        <Group gap={6}>
          <IconLayoutGrid size={14} />
          <Text size="sm" fw={600}>
            Marketplace curation
          </Text>
        </Group>

        {metaQuery.isLoading ? (
          <Text size="xs" c="dimmed">
            Loading…
          </Text>
        ) : metaQuery.isError ? (
          <Alert color="red" icon={<IconAlertTriangle size={16} />}>
            {metaQuery.error.message}
          </Alert>
        ) : (
          <>
            {!isApproved && (
              <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
                This app is{' '}
                <Code>{meta?.status ?? 'unknown'}</Code> — only an approved app can be
                featured. Category/order can still be set.
              </Alert>
            )}
            <Select
              label="Category"
              data={CATEGORY_SELECT_DATA}
              value={category}
              onChange={(v) => setCategory((v as MarketplaceCategory) || null)}
              placeholder="No category"
              clearable
              disabled={busy}
              w={240}
            />
            <Switch
              label="Featured (staff pick rail)"
              checked={featured}
              onChange={(e) => setFeatured(e.currentTarget.checked)}
              disabled={busy || !isApproved}
            />
            <NumberInput
              label="Featured order (lower = earlier)"
              value={featuredOrder ?? ''}
              onChange={(v) =>
                setFeaturedOrder(typeof v === 'number' ? v : v === '' ? null : Number(v))
              }
              min={0}
              max={100000}
              allowDecimal={false}
              placeholder="unset"
              disabled={busy}
              w={240}
            />
            <Group justify="flex-end">
              <Button
                size="xs"
                leftSection={<IconCheck size={14} />}
                disabled={!dirty || busy}
                loading={busy}
                onClick={() =>
                  saveMut.mutate({
                    appBlockId,
                    category: category ?? null,
                    featured,
                    featuredOrder: featuredOrder ?? null,
                  })
                }
              >
                Save curation
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Line-level code diff — expands the file-level summary with the actual unified
// line diff per changed/added text file. Lazy: the query only fires once the mod
// toggles "Show code diff" on, so the modal default stays light. Bounded
// server-side (text-only, byte/line/file caps); elided files render a "view in
// Forgejo" fallback rather than inlining unbounded content.
//
// The presentational panels (FileListPreview / FileDiffEntry / DiffHunkView /
// ManifestDiffPreview) + the FileLineDiff type live in the server-free
// `~/components/Apps/reviewDiffPanels` module so they can be unit tested in
// browser mode without importing this page's tRPC server graph.
// ---------------------------------------------------------------------------

function CodeDiffPanel({
  publishRequestId,
  forgejoUrl,
}: {
  publishRequestId: string;
  forgejoUrl: string;
}) {
  const features = useFeatureFlags();
  const [show, setShow] = useState(false);

  const { data, isLoading, error } = trpc.blocks.getPublishRequestDiff.useQuery(
    { publishRequestId },
    // Only fetch once toggled on (lazy). retry:false keeps a failed fetch from
    // hammering MinIO/Forgejo for a request with no diffable artifact.
    { enabled: !!features?.appBlocks && show, retry: false }
  );

  const files = (data?.files ?? []) as FileLineDiff[];

  return (
    <Stack gap={4}>
      <Group gap={8}>
        <Switch
          size="sm"
          label="Show code diff"
          checked={show}
          onChange={(e) => setShow(e.currentTarget.checked)}
        />
        {show && !isLoading && !error && (
          <Text size="xs" c="dimmed">
            {files.length} file{files.length === 1 ? '' : 's'} changed
            {data?.truncated ? ' (some elided — view in Forgejo)' : ''}
          </Text>
        )}
      </Group>

      {show &&
        (isLoading ? (
          <Text size="xs" c="dimmed">
            Computing line diff from the submitted bundle…
          </Text>
        ) : error ? (
          <Text size="xs" c="red">
            Could not load code diff: {error.message}
          </Text>
        ) : files.length === 0 ? (
          <Text size="xs" c="dimmed">
            No textual file changes to show.
          </Text>
        ) : (
          <Stack gap={6}>
            {files.map((f) => (
              <FileDiffEntry key={f.path} file={f} forgejoUrl={forgejoUrl} />
            ))}
          </Stack>
        ))}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Structured manifest renderer (replaces the raw JSON dump)
// ---------------------------------------------------------------------------

function ManifestView({ manifest }: { manifest: Record<string, unknown> }) {
  return (
    <Stack gap="sm">
      <ManifestIdentity manifest={manifest} />
      <ManifestScopes manifest={manifest} />
      <ManifestTargets manifest={manifest} />
      <ManifestSettings manifest={manifest} />
    </Stack>
  );
}

function ManifestIdentity({ manifest }: { manifest: Record<string, unknown> }) {
  const name = typeof manifest.name === 'string' ? manifest.name : null;
  const description =
    typeof manifest.description === 'string' ? manifest.description : null;
  const blockId = typeof manifest.blockId === 'string' ? manifest.blockId : null;
  const version = typeof manifest.version === 'string' ? manifest.version : null;
  const contentRating =
    typeof manifest.contentRating === 'string' ? manifest.contentRating : null;
  const trustTier = typeof manifest.trustTier === 'string' ? manifest.trustTier : null;
  const renderMode = typeof manifest.renderMode === 'string' ? manifest.renderMode : null;

  return (
    <Card withBorder p="sm">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start">
          <Stack gap={2}>
            {name && (
              <Text size="md" fw={600}>
                {name}
              </Text>
            )}
            <Group gap={6}>
              {blockId && <Code>{blockId}</Code>}
              {version && (
                <Badge color="gray" variant="light">
                  v{version}
                </Badge>
              )}
            </Group>
          </Stack>
          <Group gap={6}>
            {contentRating && (
              <Tooltip label="Content rating">
                <Badge color={ratingColor(contentRating)} variant="filled">
                  {contentRating}
                </Badge>
              </Tooltip>
            )}
            {trustTier && (
              <Tooltip label="Trust tier">
                <Badge color={trustColor(trustTier)} variant="light">
                  {trustTier}
                </Badge>
              </Tooltip>
            )}
            {renderMode && (
              <Tooltip label="Render mode">
                <Badge color="gray" variant="outline">
                  {renderMode}
                </Badge>
              </Tooltip>
            )}
          </Group>
        </Group>
        {description && (
          <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
            {description}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

function ratingColor(rating: string): string {
  switch (rating.toLowerCase()) {
    case 'g':
      return 'green';
    case 'pg':
      return 'lime';
    case 'pg13':
      return 'yellow';
    case 'r':
      return 'orange';
    case 'x':
    case 'xxx':
      return 'red';
    default:
      return 'gray';
  }
}

function trustColor(tier: string): string {
  switch (tier.toLowerCase()) {
    case 'internal':
      return 'blue';
    case 'verified':
      return 'green';
    case 'unverified':
      return 'orange';
    default:
      return 'gray';
  }
}

function ManifestScopeRow({
  scope,
  justifications,
}: {
  scope: string;
  justifications: Record<string, unknown>;
}) {
  const desc = SCOPE_DESCRIPTIONS[scope];
  const known = !!desc;
  const sensitive = isSensitiveBlockScope(scope);
  const rawJustification = justifications[scope];
  const justification =
    typeof rawJustification === 'string' && rawJustification.trim().length > 0
      ? rawJustification.trim()
      : null;
  return (
    <Stack gap={2}>
      <Group gap={8} align="flex-start" wrap="nowrap">
        <Badge
          variant={known ? 'light' : 'outline'}
          color={known ? (sensitive ? 'orange' : 'blue') : 'red'}
          style={{ fontFamily: 'ui-monospace, monospace' }}
        >
          {scope}
        </Badge>
        {sensitive && <SensitiveScopeBadge />}
        <Text size="xs" c={known ? 'dimmed' : 'red'}>
          {desc ?? 'Unknown scope — would fail at token issuance.'}
        </Text>
      </Group>
      {justification ? (
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
          <Text span fw={600} c="dimmed">
            Why:{' '}
          </Text>
          {justification}
        </Text>
      ) : (
        <Text size="xs" c="dimmed" fs="italic">
          No justification provided
        </Text>
      )}
    </Stack>
  );
}

function ManifestScopes({ manifest }: { manifest: Record<string, unknown> }) {
  const scopes = Array.isArray(manifest.scopes)
    ? (manifest.scopes as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  // Optional dev-supplied per-scope justification (scope-id → rationale). Shown
  // to the moderator so they can weigh WHY the app requested each permission.
  // NOTE: these are the developer's STATED rationale — the platform does not (yet)
  // verify the claims; this surface only DISPLAYS them.
  const justifications =
    manifest.scopeJustifications &&
    typeof manifest.scopeJustifications === 'object' &&
    !Array.isArray(manifest.scopeJustifications)
      ? (manifest.scopeJustifications as Record<string, unknown>)
      : {};
  // Split the declared scopes into a SENSITIVE group (elevated-risk — rendered
  // first with warning emphasis) and the normal group. Each group keeps the
  // existing "(N)" count semantics for its own members.
  const sensitiveScopes = scopes.filter((s) => isSensitiveBlockScope(s));
  const normalScopes = scopes.filter((s) => !isSensitiveBlockScope(s));
  return (
    <Card withBorder p="sm">
      <Stack gap="xs">
        {scopes.length === 0 ? (
          <>
            <Group gap={6}>
              <IconKey size={14} />
              <Text size="sm" fw={600}>
                Permissions (0)
              </Text>
              <Tooltip
                multiline
                w={280}
                label="Permissions the block requests. They are encoded as scopes in the app's signed block-token JWT (distinct from OAuth scopes) and enforced per-operation server-side: every capability re-verifies the token and checks the required scope before it runs."
              >
                <ThemeIcon size="xs" variant="subtle" color="gray">
                  <IconInfoCircle size={13} />
                </ThemeIcon>
              </Tooltip>
            </Group>
            <Text size="xs" c="dimmed" fs="italic">
              No permissions requested — block can only consume host postMessage
              data, no scope-gated platform APIs.
            </Text>
          </>
        ) : (
          <>
            {sensitiveScopes.length > 0 && (
              <Stack gap={8}>
                <Group gap={6}>
                  <IconAlertTriangle size={14} color="var(--mantine-color-orange-6)" />
                  <Text size="sm" fw={600} c="orange">
                    Sensitive permissions ({sensitiveScopes.length})
                  </Text>
                  <Tooltip
                    multiline
                    w={280}
                    label="Elevated-risk permissions — these let the app spend the viewer's Buzz, read the viewer's Buzz balance or private data, or write data other users see. Review the justification for each carefully."
                  >
                    <ThemeIcon size="xs" variant="subtle" color="orange">
                      <IconInfoCircle size={13} />
                    </ThemeIcon>
                  </Tooltip>
                </Group>
                {sensitiveScopes.map((s) => (
                  <ManifestScopeRow key={s} scope={s} justifications={justifications} />
                ))}
              </Stack>
            )}
            <Group gap={6}>
              <IconKey size={14} />
              <Text size="sm" fw={600}>
                Permissions ({normalScopes.length})
              </Text>
              <Tooltip
                multiline
                w={280}
                label="Permissions the block requests. They are encoded as scopes in the app's signed block-token JWT (distinct from OAuth scopes) and enforced per-operation server-side: every capability re-verifies the token and checks the required scope before it runs."
              >
                <ThemeIcon size="xs" variant="subtle" color="gray">
                  <IconInfoCircle size={13} />
                </ThemeIcon>
              </Tooltip>
            </Group>
            {normalScopes.length === 0 ? (
              <Text size="xs" c="dimmed" fs="italic">
                No non-sensitive permissions requested.
              </Text>
            ) : (
              <Stack gap={8}>
                {normalScopes.map((s) => (
                  <ManifestScopeRow key={s} scope={s} justifications={justifications} />
                ))}
              </Stack>
            )}
          </>
        )}
      </Stack>
    </Card>
  );
}

function ManifestTargets({ manifest }: { manifest: Record<string, unknown> }) {
  const targets = Array.isArray(manifest.targets)
    ? (manifest.targets as Array<Record<string, unknown>>)
    : [];
  if (targets.length === 0) return null;
  return (
    <Card withBorder p="sm">
      <Stack gap="xs">
        <Group gap={6}>
          <IconLayoutGrid size={14} />
          <Text size="sm" fw={600}>
            Slot targets ({targets.length})
          </Text>
        </Group>
        <Stack gap={6}>
          {targets.map((t, i) => {
            const slotId = typeof t.slotId === 'string' ? t.slotId : '?';
            const priority = typeof t.priority === 'number' ? t.priority : null;
            const requiredContext = Array.isArray(t.requiredContext)
              ? (t.requiredContext as unknown[]).filter(
                  (c): c is string => typeof c === 'string'
                )
              : [];
            const slotDesc = SLOT_DESCRIPTIONS[slotId];
            return (
              <Stack key={i} gap={2}>
                <Group gap={6}>
                  <Code>{slotId}</Code>
                  {priority !== null && (
                    <Badge size="xs" color="gray" variant="light">
                      priority {priority}
                    </Badge>
                  )}
                </Group>
                {slotDesc && (
                  <Text size="xs" c="dimmed" pl={4}>
                    {slotDesc}
                  </Text>
                )}
                {requiredContext.length > 0 && (
                  <Group gap={4} pl={4}>
                    <Text size="xs" c="dimmed">
                      requires:
                    </Text>
                    {requiredContext.map((c) => (
                      <Code key={c} style={{ fontSize: 10 }}>
                        {c}
                      </Code>
                    ))}
                  </Group>
                )}
              </Stack>
            );
          })}
        </Stack>
      </Stack>
    </Card>
  );
}

function ManifestSettings({ manifest }: { manifest: Record<string, unknown> }) {
  const settings =
    manifest.settings && typeof manifest.settings === 'object'
      ? (manifest.settings as Record<string, unknown>)
      : null;
  const entries = settings ? Object.entries(settings) : [];
  if (entries.length === 0) return null;
  return (
    <Card withBorder p="sm">
      <Stack gap="xs">
        <Group gap={6}>
          <IconAdjustmentsAlt size={14} />
          <Text size="sm" fw={600}>
            Settings ({entries.length})
          </Text>
        </Group>
        <Stack gap={8}>
          {entries.map(([key, raw]) => {
            const def =
              raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
            const type = typeof def.type === 'string' ? def.type : '?';
            const widget = typeof def.widget === 'string' ? def.widget : null;
            const label = typeof def.label === 'string' ? def.label : null;
            const description =
              typeof def.description === 'string' ? def.description : null;
            const scope = typeof def.scope === 'string' ? def.scope : null;
            const defaultVal = def.default;
            const min = typeof def.min === 'number' ? def.min : null;
            const max = typeof def.max === 'number' ? def.max : null;
            const requiresScope =
              typeof def.requires_scope === 'string' ? def.requires_scope : null;
            return (
              <Stack key={key} gap={2}>
                <Group gap={6} wrap="nowrap" align="baseline">
                  <Code style={{ fontSize: 11 }}>{key}</Code>
                  <Badge size="xs" variant="light">
                    {type}
                    {widget && widget !== type ? `/${widget}` : ''}
                  </Badge>
                  {scope && (
                    <Badge size="xs" color="gray" variant="outline">
                      {scope}
                    </Badge>
                  )}
                  {requiresScope && (
                    <Badge size="xs" color="blue" variant="outline">
                      needs {requiresScope}
                    </Badge>
                  )}
                </Group>
                {label && (
                  <Text size="xs" pl={4}>
                    {label}
                  </Text>
                )}
                {description && (
                  <Text size="xs" c="dimmed" pl={4}>
                    {description}
                  </Text>
                )}
                <Group gap={8} pl={4}>
                  {defaultVal !== undefined && (
                    <Text size="xs" c="dimmed">
                      default:{' '}
                      <Code style={{ fontSize: 10 }}>{JSON.stringify(defaultVal)}</Code>
                    </Text>
                  )}
                  {(min !== null || max !== null) && (
                    <Text size="xs" c="dimmed">
                      range: {min ?? '−∞'} – {max ?? '+∞'}
                    </Text>
                  )}
                </Group>
              </Stack>
            );
          })}
        </Stack>
      </Stack>
    </Card>
  );
}
