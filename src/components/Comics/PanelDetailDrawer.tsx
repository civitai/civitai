import { ActionIcon, Badge, Button, Text, Title } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCopy,
  IconMessages,
  IconPencil,
  IconPlus,
  IconRefreshDot,
  IconShield,
  IconSparkles,
  IconTrash,
  IconUser,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { openConfirmModal } from '@mantine/modals';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { getNsfwLabel } from '~/components/Comics/PanelCard';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { openSetBrowsingLevelModal } from '~/components/Dialog/triggers/set-browsing-level';
import { ImageResources } from '~/components/Image/DetailV2/ImageResources';
import { ImageMetaModal } from '~/components/Post/EditV2/ImageMetaModal';
import { BlockedReason, NsfwLevel } from '~/server/common/enums';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { hasSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { trpc } from '~/utils/trpc';
import styles from '~/pages/comics/project/[id]/ProjectWorkspace.module.scss';

interface PanelDetailDrawerProps {
  detailPanelId: number | null;
  setDetailPanelId: (id: number | null) => void;
  projectId: number;
  /** Active chapter position — needed so cache invalidations target the right `getChapter` query. */
  chapterPosition: number;
  detailPanel: {
    id: number;
    imageId?: number | null;
    imageUrl: string | null;
    image?: {
      width: number;
      height: number;
      nsfwLevel: number;
      // Surfaced so the drawer can show the "Add generation details" CTA
      // when the underlying Image was blocked for AI verification. The
      // remaining moderation fields are populated by `getChapter` but
      // not used here directly — the badge on PanelCard handles those.
      blockedFor?: string | null;
      meta?: Record<string, unknown> | null;
    } | null;
    status: string;
    prompt: string;
    enhancedPrompt: string | null;
    errorMessage: string | null;
    metadata: Record<string, any> | null;
    references?: { referenceId: number }[];
    createdAt: Date;
  } | null;
  detailPanelIndex: number;
  referenceNameMap: Map<number, string>;
  onRegenerate: (panel: NonNullable<PanelDetailDrawerProps['detailPanel']>) => void;
  onInsertAfter: (index: number) => void;
  onDuplicate: (panelId: number) => void;
  onDelete: (panelId: number) => void;
  onIterativeEdit?: (panel: NonNullable<PanelDetailDrawerProps['detailPanel']>) => void;
}

export function PanelDetailDrawer({
  detailPanelId,
  setDetailPanelId,
  projectId,
  chapterPosition,
  detailPanel,
  detailPanelIndex,
  referenceNameMap,
  onRegenerate,
  onInsertAfter,
  onDuplicate,
  onDelete,
  onIterativeEdit,
}: PanelDetailDrawerProps) {
  const utils = trpc.useUtils();
  const features = useFeatureFlags();

  const isNsfwBlocked =
    features.isGreen &&
    detailPanel?.status === 'Ready' &&
    (detailPanel?.image
      ? !hasSafeBrowsingLevel(detailPanel.image.nsfwLevel)
      : !!detailPanel?.imageUrl);

  // Opens the standard ImageMetaModal against the panel's underlying Image
  // record. Used both for the "AI verification failed" banner CTA and for
  // the always-on "Edit generation details" action — the owner may want to
  // tweak prompt/sampler even on a panel that scanned cleanly. The same
  // server path (`post.updateImage` → `updatePostImage`) handles both: if
  // the image was blocked for `AiNotVerified` and the new meta is now
  // verifiable, it flips back to `Pending` ingestion automatically.
  const openMetaEditor = () => {
    if (!detailPanel?.imageId) return;
    dialogStore.trigger({
      component: ImageMetaModal,
      props: {
        id: detailPanel.imageId,
        meta: (detailPanel.image?.meta ?? undefined) as ImageMetaProps | undefined,
        nsfwLevel: detailPanel.image?.nsfwLevel ?? NsfwLevel.PG,
        blockedFor: detailPanel.image?.blockedFor ?? undefined,
        updateImage: () => {
          void utils.comics.getChapter.invalidate({
            projectId,
            chapterPosition,
          });
          void utils.comics.getProjectShell.invalidate({ id: projectId });
        },
      },
    });
  };

  // Lock body scroll when drawer is open
  useEffect(() => {
    if (detailPanelId != null) {
      const scrollBarWidth = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.overflow = 'hidden';
      document.body.style.paddingRight = `${scrollBarWidth}px`;
      return () => {
        document.body.style.overflow = '';
        document.body.style.paddingRight = '';
      };
    }
  }, [detailPanelId]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      <div
        className={clsx(styles.drawerBackdrop, detailPanel && styles.active)}
        onClick={() => setDetailPanelId(null)}
        onTouchMove={(e) => e.preventDefault()}
      />
      <div className={clsx(styles.drawer, detailPanel && styles.active)}>
        {detailPanel && (
          <>
            <div className={styles.drawerHeader}>
              <Title order={4} fw={700}>
                Panel #{detailPanelIndex >= 0 ? detailPanelIndex + 1 : '?'}
              </Title>
              <ActionIcon variant="subtle" c="dimmed" onClick={() => setDetailPanelId(null)}>
                <IconX size={20} />
              </ActionIcon>
            </div>

            <div className={styles.drawerContent}>
              {/* Image */}
              <div className={styles.drawerImageContainer}>
                {isNsfwBlocked ? (
                  <div
                    className="w-full flex flex-col items-center justify-center gap-2"
                    style={{ background: '#2C2E33', aspectRatio: '3/4', opacity: 0.6 }}
                  >
                    <IconX size={32} />
                    <Text size="sm" c="dimmed" ta="center">
                      Mature content is not available on this site
                    </Text>
                  </div>
                ) : detailPanel.imageUrl ? (
                  <img src={getEdgeUrl(detailPanel.imageUrl, { width: 800 })} alt="Panel" />
                ) : (
                  <div
                    className="w-full flex items-center justify-center"
                    style={{ background: '#2C2E33', aspectRatio: '3/4' }}
                  >
                    {detailPanel.status === 'Generating' || detailPanel.status === 'Pending' ? (
                      <div className={styles.spinner} />
                    ) : (
                      <IconAlertTriangle size={32} style={{ color: '#fa5252' }} />
                    )}
                  </div>
                )}
              </div>

              {/* AI verification fix — when the panel's image was blocked
                  because we couldn't verify it was AI-generated, give the
                  owner a way to add the generation metadata (prompt,
                  sampler, steps, etc.) inline. Submitting via
                  `post.updateImage` re-runs the AI-verification audit, and
                  if the new meta is sufficient the image goes back to
                  `Pending` ingestion and the chapter unblocks
                  automatically once it's re-scanned. */}
              {detailPanel.imageId &&
                detailPanel.image?.blockedFor === BlockedReason.AiNotVerified && (
                  <div
                    className="rounded-md p-3 flex flex-col gap-2"
                    style={{
                      border: '1px solid var(--mantine-color-yellow-7)',
                      background: 'rgba(250, 176, 5, 0.08)',
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <IconAlertTriangle size={16} style={{ color: '#fab005' }} />
                      <Text size="sm" fw={600} c="yellow">
                        AI generation could not be verified
                      </Text>
                    </div>
                    <Text size="xs" c="dimmed">
                      This panel was blocked because we couldn&apos;t verify it was AI-generated
                      from its metadata. Add the prompt, sampler, steps and other settings used to
                      generate it, and we&apos;ll re-scan it automatically.
                    </Text>
                    <Button
                      size="compact-sm"
                      color="yellow"
                      variant="light"
                      leftSection={<IconPencil size={14} />}
                      onClick={openMetaEditor}
                    >
                      Add generation details
                    </Button>
                  </div>
                )}

              {/* Status + Reference row */}
              <div className="flex items-center gap-3 flex-wrap">
                <div className={styles.detailStatusBadge}>
                  <span
                    className={clsx(styles.detailStatusDot, {
                      [styles.ready]: detailPanel.status === 'Ready',
                      [styles.generating]:
                        detailPanel.status === 'Generating' || detailPanel.status === 'Pending',
                      [styles.failed]: detailPanel.status === 'Failed',
                    })}
                  />
                  {detailPanel.status === 'Pending' ? 'Queued' : detailPanel.status}
                </div>
                {(detailPanel.references ?? []).map((r: { referenceId: number }) => {
                  const name = referenceNameMap.get(r.referenceId);
                  return name ? (
                    <span key={r.referenceId} className={styles.detailCharacterPill}>
                      <IconUser size={14} />
                      {name}
                    </span>
                  ) : null;
                })}
                <div className="flex-1" />
                <Text size="xs" c="dimmed">
                  {new Date(detailPanel.createdAt).toLocaleDateString()}
                </Text>
              </div>

              {/* NSFW Rating */}
              {detailPanel.imageId && detailPanel.image?.nsfwLevel != null && (
                <div>
                  <div className={styles.detailSectionTitle}>Content Rating</div>
                  <div className="flex items-center gap-2">
                    {(() => {
                      const nsfwInfo = getNsfwLabel(detailPanel.image.nsfwLevel);
                      return nsfwInfo ? (
                        <Badge size="sm" color={nsfwInfo.color} variant="filled">
                          {nsfwInfo.label}
                        </Badge>
                      ) : (
                        <Badge size="sm" color="gray" variant="filled">
                          Unrated
                        </Badge>
                      );
                    })()}
                    <button
                      className={styles.subtleBtnSm}
                      onClick={() => {
                        openSetBrowsingLevelModal({
                          imageId: detailPanel.imageId!,
                          nsfwLevel: detailPanel.image!.nsfwLevel as NsfwLevel,
                          onSubmit: () => {
                            // Rating change shifts the panel's nsfwLevel,
                            // which feeds both the chapter NSFW aggregate
                            // (shell) and the per-panel render (chapter).
                            void utils.comics.getProjectShell.invalidate({ id: projectId });
                            void utils.comics.getChapter.invalidate({
                              projectId,
                              chapterPosition,
                            });
                          },
                        });
                      }}
                    >
                      <IconShield size={14} />
                      Change Rating
                    </button>
                  </div>
                </div>
              )}

              {/* Original prompt (hide for imported panels with no prompt) */}
              {detailPanel.prompt ? (
                <div>
                  <div className={styles.detailSectionTitle}>Original Prompt</div>
                  <div className={styles.promptBox}>{detailPanel.prompt}</div>
                </div>
              ) : null}

              {/* Enhanced prompt */}
              {detailPanel.enhancedPrompt && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className={styles.detailSectionTitle} style={{ marginBottom: 0 }}>
                      Enhanced Prompt
                    </span>
                    <span className={styles.enhancedBadge}>
                      <IconSparkles size={12} />
                      Enhanced
                    </span>
                  </div>
                  <div className={clsx(styles.promptBox, styles.promptBoxEnhanced)}>
                    {detailPanel.enhancedPrompt}
                  </div>
                </div>
              )}

              {/* Error */}
              {detailPanel.errorMessage && (
                <div>
                  <div className={styles.detailSectionTitle}>Error</div>
                  <div
                    className={styles.promptBox}
                    style={{ borderColor: '#fa5252', color: '#fa5252' }}
                  >
                    {detailPanel.errorMessage}
                  </div>
                </div>
              )}

              {/* Source Image (for enhanced panels, not for plain imports) */}
              {(detailPanel.metadata as Record<string, any> | null)?.sourceImageUrl &&
                detailPanel.prompt && (
                  <div>
                    <div className={styles.detailSectionTitle}>Source Image</div>
                    <div className={styles.enhanceImagePreview}>
                      <img
                        src={
                          getEdgeUrl((detailPanel.metadata as Record<string, any>).sourceImageUrl, {
                            width: 400,
                          }) ?? (detailPanel.metadata as Record<string, any>).sourceImageUrl
                        }
                        alt="Source"
                      />
                    </div>
                  </div>
                )}

              {/* Generation settings */}
              {(() => {
                const meta = detailPanel.metadata as Record<string, any> | null;

                // Imported panels: no metadata at all (createPanelFromImage), or
                // metadata with sourceImageUrl but no generation flags (enhancePanel without prompt)
                const isImported =
                  !detailPanel.prompt &&
                  (!meta || (meta.sourceImageUrl && meta.enhanceEnabled === undefined));

                if (isImported) {
                  return (
                    <div>
                      <div className={styles.detailSectionTitle}>Settings</div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={styles.detailCharacterPill}>Imported image</span>
                      </div>
                    </div>
                  );
                }

                if (!meta) return null;

                return (
                  <div>
                    <div className={styles.detailSectionTitle}>Settings</div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={styles.detailCharacterPill}>
                        {meta.enhanceEnabled !== false ? 'Prompt enhanced' : 'Prompt not enhanced'}
                      </span>
                      {meta.enhanceEnabled !== false && (
                        <span className={styles.detailCharacterPill}>
                          {meta.useContext !== false
                            ? 'Previous context used'
                            : 'No previous context'}
                        </span>
                      )}
                      {(meta.referencePanelId || meta.includePreviousImage) && (
                        <span className={styles.detailCharacterPill}>
                          {meta.referencePanelId
                            ? `Panel #${meta.referencePanelId} referenced`
                            : 'Previous image referenced'}
                        </span>
                      )}
                      {meta.sourceImageUrl && (
                        <span className={styles.detailCharacterPill}>Enhanced from image</span>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Resources used — model/checkpoint + LoRAs etc. that produced
                  this panel. Sourced from the Image's resource helper via
                  trpc.image.getGenerationData. Only shown for Ready panels
                  with an underlying image record. */}
              {detailPanel.imageId && detailPanel.status === 'Ready' && (
                <ImageResources imageId={detailPanel.imageId} />
              )}

              {/* Actions */}
              <div className={styles.detailActions}>
                {detailPanel.status === 'Ready' && detailPanel.imageUrl && onIterativeEdit && (
                  <button
                    className={styles.subtleBtn}
                    onClick={() => onIterativeEdit(detailPanel)}
                    title="Iterative Edit"
                  >
                    <IconMessages size={16} />
                    Iterative Edit
                  </button>
                )}
                {(detailPanel.status === 'Ready' || detailPanel.status === 'Failed') && (
                  <button className={styles.gradientBtn} onClick={() => onRegenerate(detailPanel)}>
                    <IconRefreshDot size={16} />
                    Regenerate
                  </button>
                )}
                {detailPanelIndex >= 0 && (
                  <button
                    className={styles.subtleBtn}
                    onClick={() => onInsertAfter(detailPanelIndex)}
                  >
                    <IconPlus size={14} />
                    Insert after
                  </button>
                )}
                {detailPanel.imageId && (
                  <button
                    className={styles.subtleBtn}
                    onClick={openMetaEditor}
                    title="Edit generation metadata (prompt, sampler, steps, etc.)"
                  >
                    <IconPencil size={14} />
                    Edit metadata
                  </button>
                )}
                <button className={styles.subtleBtn} onClick={() => onDuplicate(detailPanel.id)}>
                  <IconCopy size={14} />
                  Duplicate
                </button>
                <button
                  className={styles.dangerBtn}
                  onClick={() => {
                    openConfirmModal({
                      title: 'Delete Panel',
                      children: <Text size="sm">Are you sure you want to delete this panel?</Text>,
                      labels: { confirm: 'Delete', cancel: 'Cancel' },
                      confirmProps: { color: 'red' },
                      onConfirm: () => onDelete(detailPanel.id),
                    });
                  }}
                >
                  <IconTrash size={14} />
                  Delete
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </>,
    document.body
  );
}
