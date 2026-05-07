import { ActionIcon, Badge, Button, Loader, Menu, Text, Tooltip } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCopy,
  IconDotsVertical,
  IconEye,
  IconMessages,
  IconPhoto,
  IconPhotoSearch,
  IconPlus,
  IconRefreshDot,
  IconTrash,
  IconUser,
} from '@tabler/icons-react';
import { CSS } from '@dnd-kit/utilities';
import { useSortable } from '@dnd-kit/sortable';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { openSetBrowsingLevelModal } from '~/components/Dialog/triggers/set-browsing-level';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { NsfwLevel, SignalMessages } from '~/server/common/enums';
import { ComicPanelStatus } from '~/shared/utils/prisma/enums';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useServerDomains } from '~/providers/AppProvider';
import { syncAccount } from '~/utils/sync-account';
import { hasSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { CandidateImageModal } from '~/components/Comics/CandidateImageModal';
import { IconEyeOff, IconExternalLink } from '@tabler/icons-react';
import styles from '~/pages/comics/project/[id]/ProjectWorkspace.module.scss';

const nsfwBadgeColors: Record<number, string> = {
  [NsfwLevel.PG]: 'green',
  [NsfwLevel.PG13]: 'yellow',
  [NsfwLevel.R]: 'orange',
  [NsfwLevel.X]: 'red',
  [NsfwLevel.XXX]: 'red',
  [NsfwLevel.Blocked]: 'gray',
};

export function getNsfwLabel(level: number): { label: string; color: string } | null {
  // Find highest set bit
  const highest = [NsfwLevel.Blocked, NsfwLevel.XXX, NsfwLevel.X, NsfwLevel.R, NsfwLevel.PG13, NsfwLevel.PG]
    .find((l) => level & l);
  if (!highest) return null;
  return {
    label: browsingLevelLabels[highest as keyof typeof browsingLevelLabels] ?? 'Unknown',
    color: nsfwBadgeColors[highest] ?? 'gray',
  };
}

export interface PanelCardProps {
  panel: {
    id: number;
    imageId: number | null;
    imageUrl: string | null;
    prompt: string;
    status: string;
    workflowId: string | null;
    errorMessage: string | null;
    metadata?: any;
    image?: { nsfwLevel: number } | null;
  };
  projectId: number;
  /**
   * Chapter the panel belongs to. Needed for `getChapter` cache writes when
   * patching panel state from polling / selection responses.
   */
  chapterPosition: number;
  position: number;
  referenceNames: string[];
  onDelete: () => void;
  onRegenerate: () => void;
  onDuplicate: () => void;
  isDuplicating?: boolean;
  onInsertAfter: () => void;
  onClick: () => void;
  onIterativeEdit?: () => void;
  onRatingChange?: () => void;
}

export function PanelCard({
  panel,
  projectId,
  chapterPosition,
  position,
  referenceNames,
  onDelete,
  onRegenerate,
  onDuplicate,
  isDuplicating,
  onInsertAfter,
  onClick,
  onIterativeEdit,
  onRatingChange,
}: PanelCardProps) {
  const { imageUrl, prompt, status, errorMessage } = panel;
  const utils = trpc.useUtils();
  const { isGreen } = useFeatureFlags();

  // Panel is blocked when it has NSFW content and we're on the green domain.
  // The server strips imageUrl from NSFW panels, so a Ready panel with no imageUrl on green
  // means it was blocked. Check image nsfwLevel when available, otherwise trust the server.
  const isNsfwBlocked =
    isGreen &&
    status === 'Ready' &&
    (panel.image ? !hasSafeBrowsingLevel(panel.image.nsfwLevel) : true);

  // `RequireUnlock` is a non-terminal "owner action required" state, set by
  // the poll endpoint whenever `BlobData` derived a `blockedReason` on the
  // generation output. The CTA picks between two flows based purely on
  // the *current viewer's* domain — NOT the persisted `blockedReason`,
  // which only reflects whichever domain the last poll happened on:
  //  * On green (SFW): always redirect to civitai.red. Mature content
  //    cannot be lifted in place here. The server-side unlock mutation
  //    also rejects on green as a defense in depth.
  //  * On red: in-place yellow-Buzz unlock (mirrors QueueItem's
  //    `CanUpgradeBlock`). Workflow's `allowMatureContent` is flipped to
  //    true and the result is downloaded into S3 inline.
  const requiresUnlock = status === 'RequireUnlock';
  const redDomain = useServerDomains().red;
  const unlockHref =
    isGreen && redDomain
      ? syncAccount(`//${redDomain}/comics/project/${projectId}/chapter/${chapterPosition}`)
      : null;


  // Build the per-candidate slot list from persisted metadata. Each slot is
  // either downloaded (`{ key }`) or locked (`{ requiresUnlock, blockedReason }`,
  // no URL persisted). `nsfwLevel` is the orchestrator-derived level for
  // the slot — the picker uses it to blur clean-but-mature candidates so
  // mature results don't render uncensored just because they made it past
  // the `blockedReason` gate.
  type CandidateSlot =
    | { key: string; requiresUnlock?: false; nsfwLevel?: number | null }
    | {
        key?: undefined;
        requiresUnlock: true;
        blockedReason: string;
        blurredPreviewUrl?: string | null;
        nsfwLevel?: number | null;
      };

  const metaCandidates = panel.metadata?.candidateImages as
    | Array<{
        key?: string;
        requiresUnlock?: boolean;
        blockedReason?: string;
        nsfwLevel?: number | null;
      }>
    | undefined;
  const initialSlots: CandidateSlot[] | null = Array.isArray(metaCandidates)
    ? metaCandidates.map((c) =>
        c?.requiresUnlock
          ? {
              requiresUnlock: true as const,
              blockedReason: c.blockedReason ?? 'canUpgrade',
              nsfwLevel: c.nsfwLevel ?? null,
            }
          : {
              key: typeof c === 'string' ? (c as unknown as string) : (c?.key ?? ''),
              nsfwLevel: typeof c === 'string' ? null : (c?.nsfwLevel ?? null),
            }
      )
    : null;
  const [candidateSlots, setCandidateSlots] = useState<CandidateSlot[] | null>(
    initialSlots && initialSlots.length > 0 ? initialSlots : null
  );
  const [candidateModalOpen, setCandidateModalOpen] = useState(false);
  const hasLockedCandidate = !!candidateSlots?.some((s) => s.requiresUnlock);

  // Polling continues for `RequireUnlock` (single-image blocked) AND for
  // `AwaitingSelection` panels that still have at least one locked candidate
  // — both states need transient preview-URL refreshes that we deliberately
  // never persist.
  const isActive =
    status === 'Generating' ||
    status === 'Pending' ||
    status === 'Enqueued' ||
    status === 'RequireUnlock' ||
    (status === 'AwaitingSelection' && hasLockedCandidate);

  // Patch this panel's data directly in the chapter cache (no full refetch
  // needed). Panels live on `getChapter` keyed by `{ projectId, chapterPosition }`.
  const patchPanel = useCallback(
    (update: { status: string; imageUrl?: string | null; errorMessage?: string | null }) => {
      utils.comics.getChapter.setData(
        { projectId, chapterPosition },
        (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            panels: prev.panels.map((p) =>
              p.id === panel.id
                ? {
                    ...p,
                    status: update.status as ComicPanelStatus,
                    imageUrl: update.imageUrl ?? p.imageUrl,
                    ...(update.errorMessage !== undefined ? { errorMessage: update.errorMessage } : {}),
                  }
                : p
            ),
          };
        }
      );
    },
    [utils, projectId, chapterPosition, panel.id]
  );

  const selectPanelImageMutation = trpc.comics.selectPanelImage.useMutation({
    onSuccess: (data) => {
      setCandidateModalOpen(false);
      patchPanel({ status: data.status, imageUrl: data.imageUrl });
    },
    onError: () => {
      // Selection failed — modal stays open so user can retry
    },
  });

  // Transient blurred preview from the orchestrator for blocked panels. We
  // deliberately keep this in component state ONLY — it must never round-trip
  // through panel.imageUrl or any other persisted field. On page refresh the
  // initial-fetch effect below pulls a fresh URL from the orchestrator.
  const [blurredPreviewUrl, setBlurredPreviewUrl] = useState<string | null>(null);

  // Poll server to check orchestrator status and download image when ready
  const isPollingRef = useRef(false);
  const pollOnce = useCallback(async () => {
    if (isPollingRef.current) return;
    isPollingRef.current = true;
    try {
      const result = await utils.comics.pollPanelStatus.fetch({ panelId: panel.id }, {
        cacheTime: 0,
      }) as any;
      // New shape: per-candidate slots (clean OR locked, in stable order).
      if (Array.isArray(result.candidates) && result.candidates.length > 1) {
        setCandidateSlots(
          result.candidates.map((c: any) =>
            c?.requiresUnlock
              ? {
                  requiresUnlock: true as const,
                  blockedReason: c.blockedReason ?? 'canUpgrade',
                  blurredPreviewUrl: c.blurredPreviewUrl ?? null,
                  nsfwLevel: c.nsfwLevel ?? null,
                }
              : { key: c.key, nsfwLevel: c.nsfwLevel ?? null }
          )
        );
        if (status !== 'AwaitingSelection') {
          patchPanel({ status: 'AwaitingSelection' });
        }
        return;
      }
      // Refresh the transient blurred preview if the server returned one.
      if (typeof result.blurredPreviewUrl === 'string') {
        setBlurredPreviewUrl(result.blurredPreviewUrl);
      }
      if (
        result.status === 'Ready' ||
        result.status === 'Failed' ||
        result.status === 'RequireUnlock'
      ) {
        patchPanel({
          status: result.status,
          imageUrl: result.imageUrl,
          errorMessage: result.errorMessage ?? null,
        });
      }
    } catch {
      /* ignore */
    } finally {
      isPollingRef.current = false;
    }
  }, [utils, panel.id, patchPanel, status]);

  const unlockMutation = trpc.comics.unlockPanelGeneration.useMutation({
    onSuccess: (data: any) => {
      // Invalidate so the next render reads the freshly-written metadata
      // (with new S3 keys backfilled into previously-locked slots).
      void utils.comics.getChapter.invalidate({ projectId, chapterPosition });

      // Multi-image: server now returns the inline-downloaded candidates
      // array directly. Push it into local state so the picker reflects
      // the unlocked state without waiting for a poll round-trip.
      if (Array.isArray(data?.candidates) && data.candidates.length > 1) {
        setCandidateSlots(
          data.candidates.map((c: any) =>
            c?.requiresUnlock
              ? {
                  requiresUnlock: true as const,
                  blockedReason: c.blockedReason ?? 'canUpgrade',
                  blurredPreviewUrl: c.blurredPreviewUrl ?? null,
                  nsfwLevel: c.nsfwLevel ?? null,
                }
              : { key: c.key, nsfwLevel: c.nsfwLevel ?? null }
          )
        );
        return;
      }

      // Single-image: status came back `Ready` (or fallback `Generating`);
      // patch the cache so the panel re-renders with the unlocked image.
      patchPanel({
        status: data.status,
        imageUrl: data.imageUrl ?? null,
        errorMessage: null,
      });
    },
    // Without an explicit error handler, a failed orchestrator update (no
    // Buzz, network error, etc.) silently no-ops — the user clicks Unlock
    // and "nothing happens". Surface the error so they know what to do.
    onError: (error) => {
      showErrorNotification({
        title: 'Unlock failed',
        error: new Error(
          error.message || 'Could not unlock this generation. Please try again.'
        ),
      });
    },
  });

  // Self-contained polling: when this panel is actively generating, poll periodically.
  // Stop once *all* candidates are clean (user needs to pick) or panel reaches terminal state.
  // For AwaitingSelection with locked candidates we keep polling so the
  // ephemeral blurred-preview URLs stay fresh and we can pick up
  // newly-clean URLs after an unlock.
  const hasCandidates =
    candidateSlots != null && candidateSlots.length > 1 && !hasLockedCandidate;
  useEffect(() => {
    if (!isActive || hasCandidates) return;
    void pollOnce();
    const interval = setInterval(pollOnce, 25_000);
    return () => clearInterval(interval);
  }, [isActive, hasCandidates, pollOnce]);

  // Listen for ComicPanelUpdate signal targeting this specific panel
  useSignalConnection(
    SignalMessages.ComicPanelUpdate,
    useCallback(
      (data: { panelId: number; projectId: number; status: string; imageUrl?: string }) => {
        if (data.panelId !== panel.id) return;
        if (data.status === 'AwaitingSelection' || data.status === 'RequireUnlock') {
          // Owner action required — re-poll so we pick up candidates or the
          // transient blurred preview (Blocked never carries an imageUrl in
          // the signal because we deliberately don't persist one).
          void pollOnce();
          return;
        }
        if (data.status === 'Ready' || data.status === 'Failed') {
          patchPanel({ status: data.status, imageUrl: data.imageUrl });
        }
      },
      [panel.id, patchPanel, pollOnce]
    )
  );

  // Listen for orchestrator TextToImageUpdate matching this panel's workflowId.
  // Fires instantly when orchestrator completes — triggers poll to download image.
  useSignalConnection(
    SignalMessages.TextToImageUpdate,
    useCallback(
      (data: { $type: string; workflowId: string; status: string }) => {
        if (data.$type !== 'step' || !isActive || !panel.workflowId) return;
        if (data.workflowId !== panel.workflowId) return;
        if (data.status !== 'succeeded' && data.status !== 'failed') return;
        void pollOnce();
      },
      [isActive, panel.workflowId, pollOnce]
    )
  );

  const nsfwInfo = panel.image?.nsfwLevel ? getNsfwLabel(panel.image.nsfwLevel) : null;

  const promptPreview = prompt?.length > 80 ? `${prompt.slice(0, 80)}...` : prompt;

  return (
    <>
    <Tooltip label={promptPreview} disabled={!prompt} withArrow position="top" multiline maw={300} openDelay={400}>
    <div
      className={styles.panelCard}
      onClick={onClick}
      style={hasCandidates && !imageUrl ? {
        outline: '2px solid var(--mantine-color-yellow-6)',
        outlineOffset: -2,
        animation: 'pulse-outline 2s ease-in-out infinite',
      } : undefined}
    >
      {isDuplicating && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center rounded-lg"
          style={{ background: 'rgba(0,0,0,0.5)' }}
        >
          <Loader size="sm" color="yellow" />
        </div>
      )}
      {isNsfwBlocked ? (
        <>
          <div className={styles.panelEmpty} style={{ opacity: 0.6 }}>
            <IconEyeOff size={28} />
            <Text size="xs" c="dimmed" ta="center">
              Mature content is not available on this site
            </Text>
          </div>
          <div className="absolute top-2 left-2">
            <span className={styles.panelNumber}>#{position}</span>
          </div>
        </>
      ) : imageUrl ? (
        <>
          <img
            src={getEdgeUrl(imageUrl, { width: 450 })}
            alt={prompt}
            className={styles.panelImage}
          />
          <div className={styles.panelOverlay}>
            <div className="flex justify-between items-start">
              <div className="flex items-center gap-1">
                <span className={styles.panelNumber}>#{position}</span>
                {nsfwInfo && (
                  <Badge
                    size="xs"
                    color={nsfwInfo.color}
                    variant="filled"
                    style={{ cursor: 'pointer' }}
                    onClick={(e: React.MouseEvent) => {
                      e.stopPropagation();
                      if (panel.imageId && panel.image?.nsfwLevel != null) {
                        openSetBrowsingLevelModal({
                          imageId: panel.imageId,
                          nsfwLevel: panel.image.nsfwLevel as NsfwLevel,
                          onSubmit: () => onRatingChange?.(),
                        });
                      }
                    }}
                  >
                    {nsfwInfo.label}
                  </Badge>
                )}
              </div>
              <div className={styles.panelMenu}>
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <ActionIcon
                      variant="filled"
                      color="dark"
                      size="sm"
                      onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    >
                      <IconDotsVertical size={14} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item
                      leftSection={<IconEye size={14} />}
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        onClick();
                      }}
                    >
                      View Details
                    </Menu.Item>
                    {status === 'Ready' && imageUrl && onIterativeEdit && (
                      <Menu.Item
                        leftSection={<IconMessages size={14} />}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          onIterativeEdit();
                        }}
                      >
                        Iterative Edit
                      </Menu.Item>
                    )}
                    {status === 'Ready' && candidateSlots && candidateSlots.length > 1 && (
                      <Menu.Item
                        leftSection={<IconPhotoSearch size={14} />}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          setCandidateModalOpen(true);
                        }}
                      >
                        Change Image
                      </Menu.Item>
                    )}
                    {(status === 'Ready' || status === 'Failed') && (
                      <Menu.Item
                        leftSection={<IconRefreshDot size={14} />}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          onRegenerate();
                        }}
                      >
                        Regenerate
                      </Menu.Item>
                    )}
                    {status === 'Ready' && imageUrl && (
                      <Menu.Item
                        leftSection={<IconCopy size={14} />}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          onDuplicate();
                        }}
                      >
                        Duplicate
                      </Menu.Item>
                    )}
                    <Menu.Item
                      leftSection={<IconPlus size={14} />}
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        onInsertAfter();
                      }}
                    >
                      Insert after
                    </Menu.Item>
                    <Menu.Item
                      color="red"
                      leftSection={<IconTrash size={14} />}
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        onDelete();
                      }}
                    >
                      Delete
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              {referenceNames.length > 0 && (
                <div className="flex flex-wrap gap-1" style={{ maxHeight: 44, overflow: 'hidden' }}>
                  {referenceNames.slice(0, 3).map((name) => (
                    <span key={name} className={styles.panelCharacterPill}>
                      <IconUser size={10} />
                      {name}
                    </span>
                  ))}
                  {referenceNames.length > 3 && (
                    <span className={styles.panelCharacterPill}>
                      +{referenceNames.length - 3}
                    </span>
                  )}
                </div>
              )}
              <p className={styles.panelPrompt}>{prompt}</p>
            </div>
          </div>
        </>
      ) : candidateSlots && candidateSlots.length > 1 ? (
        <>
          <div
            className={styles.panelEmpty}
            style={{ cursor: 'pointer', color: 'var(--mantine-color-yellow-5)' }}
            onClick={(e) => {
              e.stopPropagation();
              setCandidateModalOpen(true);
            }}
          >
            <IconPhotoSearch size={28} />
            <Text size="xs" fw={600} c="yellow">
              {candidateSlots.length} images ready
            </Text>
            <Text size="xs" c="dimmed" ta="center">
              {hasLockedCandidate ? 'Some need unlock — click to view' : 'Click to choose'}
            </Text>
          </div>
          <div className="absolute top-2 left-2">
            <span className={styles.panelNumber}>#{position}</span>
          </div>
        </>
      ) : (
        <>
          {status === 'Generating' || status === 'Pending' || status === 'Enqueued' ? (
            <div className={styles.panelEmpty}>
              <div className={styles.spinner} />
              <Text size="xs">{status === 'Pending' || status === 'Enqueued' ? 'Queued' : 'Generating...'}</Text>
            </div>
          ) : requiresUnlock ? (
            <div className={styles.panelFailed} style={{ position: 'relative', overflow: 'hidden' }}>
              {/* Show the orchestrator's blurred preview to the OWNER only.
                  This URL is delivered transiently via the poll response and
                  is never persisted on the panel — that's intentional, so
                  the CDN link can't be discovered through any public
                  surface that reads `panel.imageUrl`. */}
              {blurredPreviewUrl && (
                <>
                  <img
                    src={blurredPreviewUrl}
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                  <div
                    className="absolute inset-0"
                    style={{ background: 'rgba(0,0,0,0.55)' }}
                  />
                </>
              )}
              <div className="relative flex flex-col items-center gap-1 px-2 py-3">
                <Text size="xs" c="yellow" fw={700} ta="center">
                  Mature Content
                </Text>
                {isGreen ? (
                  <>
                    <Text size="xs" c="dimmed" ta="center" px="xs">
                      This generation can only be viewed on civitai.red.
                    </Text>
                    {unlockHref ? (
                      <Button
                        component="a"
                        href={unlockHref}
                        target="_blank"
                        rel="noreferrer nofollow"
                        size="compact-xs"
                        color="red"
                        variant="light"
                        radius="xl"
                        leftSection={<IconExternalLink size={12} />}
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      >
                        Unlock on civitai.red
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <>
                    <Text size="xs" c="dimmed" ta="center" px="xs">
                      Unlock this content with{' '}
                      <Text component="span" c="yellow" inherit>
                        yellow
                      </Text>{' '}
                      Buzz!
                    </Text>
                    <Button
                      size="compact-xs"
                      color="yellow"
                      variant="light"
                      radius="xl"
                      loading={unlockMutation.isPending}
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        unlockMutation.mutate({ panelId: panel.id });
                      }}
                    >
                      Unlock
                    </Button>
                  </>
                )}
                <button
                  className="mt-1 px-3 py-1 rounded text-xs bg-dark-6 hover:bg-dark-5 text-gray-300 flex items-center gap-1"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRegenerate();
                  }}
                >
                  <IconRefreshDot size={12} />
                  Regenerate
                </button>
              </div>
            </div>
          ) : status === 'Failed' ? (
            <div className={styles.panelFailed}>
              <div className="absolute top-2 right-2">
                <div className={styles.panelMenu}>
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <ActionIcon
                        variant="filled"
                        color="dark"
                        size="sm"
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      >
                        <IconDotsVertical size={14} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconRefreshDot size={14} />}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          onRegenerate();
                        }}
                      >
                        Regenerate
                      </Menu.Item>
                      <Menu.Item
                        leftSection={<IconPlus size={14} />}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          onInsertAfter();
                        }}
                      >
                        Insert after
                      </Menu.Item>
                      <Menu.Item
                        color="red"
                        leftSection={<IconTrash size={14} />}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          onDelete();
                        }}
                      >
                        Delete
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </div>
              </div>
              <IconAlertTriangle size={28} />
              <Text size="xs" c="red">
                Failed
              </Text>
              {errorMessage && (
                <Text size="xs" c="dimmed" ta="center" lineClamp={2} px="xs">
                  {errorMessage}
                </Text>
              )}
              <Text size="xs" c="dimmed" ta="center" mt={4}>
                Buzz has been refunded
              </Text>
              <button
                className="mt-2 px-3 py-1 rounded text-xs bg-dark-6 hover:bg-dark-5 text-gray-300 flex items-center gap-1"
                onClick={(e) => {
                  e.stopPropagation();
                  onRegenerate();
                }}
              >
                <IconRefreshDot size={12} />
                Regenerate
              </button>
            </div>
          ) : (
            <div className={styles.panelEmpty}>
              <IconPhoto size={28} />
            </div>
          )}
          <div className="absolute top-2 left-2">
            <span className={styles.panelNumber}>#{position}</span>
          </div>
        </>
      )}
    </div>
    </Tooltip>
    {candidateSlots && candidateSlots.length > 1 && (
      <CandidateImageModal
        opened={candidateModalOpen}
        onClose={() => setCandidateModalOpen(false)}
        candidates={candidateSlots}
        currentImageUrl={imageUrl}
        onConfirm={(key) =>
          selectPanelImageMutation.mutate({ panelId: panel.id, selectedImageKey: key })
        }
        // CTA selection is purely domain-based: green → redirect, red →
        // in-place unlock. We never expose `onUnlock` on green because the
        // server-side mutation rejects there as well. `unlockHref` is also
        // forwarded for clean-but-mature tiles on green so the per-tile
        // redirect button can render even when no slot is `requiresUnlock`.
        onUnlock={
          hasLockedCandidate && !isGreen
            ? () => unlockMutation.mutate({ panelId: panel.id })
            : undefined
        }
        isUnlocking={unlockMutation.isPending}
        unlockHref={isGreen ? unlockHref : null}
        isSelecting={selectPanelImageMutation.isPending}
      />
    )}
    </>
  );
}

export function SortablePanel({ id, children }: { id: number; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        cursor: isDragging ? 'grabbing' : 'grab',
        opacity: isDragging ? 0.5 : 1,
        touchAction: 'none',
      }}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}
