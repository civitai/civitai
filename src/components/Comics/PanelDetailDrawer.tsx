import { ActionIcon, Text, Title } from '@mantine/core';
import {
  IconAlertTriangle,
  IconPlus,
  IconRefreshDot,
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
import styles from '~/pages/comics/project/[id]/ProjectWorkspace.module.scss';

interface PanelDetailDrawerProps {
  detailPanelId: number | null;
  setDetailPanelId: (id: number | null) => void;
  detailPanel: {
    id: number;
    imageUrl: string | null;
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
  onDelete: (panelId: number) => void;
}

export function PanelDetailDrawer({
  detailPanelId,
  setDetailPanelId,
  detailPanel,
  detailPanelIndex,
  referenceNameMap,
  onRegenerate,
  onInsertAfter,
  onDelete,
}: PanelDetailDrawerProps) {
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
              <Title order={4} style={{ fontWeight: 700 }}>
                Panel #{detailPanelIndex >= 0 ? detailPanelIndex + 1 : '?'}
              </Title>
              <ActionIcon variant="subtle" c="dimmed" onClick={() => setDetailPanelId(null)}>
                <IconX size={20} />
              </ActionIcon>
            </div>

            <div className={styles.drawerContent}>
              {/* Image */}
              <div className={styles.drawerImageContainer}>
                {detailPanel.imageUrl ? (
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

              {/* Original prompt */}
              <div>
                <div className={styles.detailSectionTitle}>Original Prompt</div>
                <div className={styles.promptBox}>{detailPanel.prompt}</div>
              </div>

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

              {/* Source Image (for enhanced panels) */}
              {(detailPanel.metadata as Record<string, any> | null)?.sourceImageUrl && (
                <div>
                  <div className={styles.detailSectionTitle}>Source Image</div>
                  <div className={styles.enhanceImagePreview}>
                    <img
                      src={
                        getEdgeUrl(
                          (detailPanel.metadata as Record<string, any>).sourceImageUrl,
                          { width: 400 }
                        ) ?? (detailPanel.metadata as Record<string, any>).sourceImageUrl
                      }
                      alt="Source"
                    />
                  </div>
                </div>
              )}

              {/* Generation settings */}
              {(() => {
                const meta = detailPanel.metadata as Record<string, any> | null;
                if (!meta) return null;
                return (
                  <div>
                    <div className={styles.detailSectionTitle}>Settings</div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={styles.detailCharacterPill}>
                        {meta.enhanceEnabled !== false
                          ? 'Prompt enhanced'
                          : 'Prompt not enhanced'}
                      </span>
                      {meta.enhanceEnabled !== false && (
                        <span className={styles.detailCharacterPill}>
                          {meta.useContext !== false
                            ? 'Previous context used'
                            : 'No previous context'}
                        </span>
                      )}
                      {meta.includePreviousImage && (
                        <span className={styles.detailCharacterPill}>
                          Previous image referenced
                        </span>
                      )}
                      {meta.sourceImageUrl && (
                        <span className={styles.detailCharacterPill}>Enhanced from image</span>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Actions */}
              <div className={styles.detailActions}>
                {(detailPanel.status === 'Ready' || detailPanel.status === 'Failed') && (
                  <button
                    className={styles.gradientBtn}
                    onClick={() => onRegenerate(detailPanel)}
                  >
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
                <button
                  className={styles.dangerBtn}
                  onClick={() => {
                    openConfirmModal({
                      title: 'Delete Panel',
                      children: (
                        <Text size="sm">Are you sure you want to delete this panel?</Text>
                      ),
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
