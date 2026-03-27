import { ActionIcon, Badge, Menu, Text, Tooltip } from '@mantine/core';
import {
  IconAlertTriangle,
  IconDotsVertical,
  IconEye,
  IconMessages,
  IconPhoto,
  IconPlus,
  IconRefreshDot,
  IconTrash,
  IconUser,
} from '@tabler/icons-react';
import { CSS } from '@dnd-kit/utilities';
import { useSortable } from '@dnd-kit/sortable';
import { useCallback, useEffect } from 'react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { openSetBrowsingLevelModal } from '~/components/Dialog/triggers/set-browsing-level';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { NsfwLevel, SignalMessages } from '~/server/common/enums';
import { ComicPanelStatus } from '~/shared/utils/prisma/enums';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { trpc } from '~/utils/trpc';
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
    image?: { nsfwLevel: number } | null;
  };
  projectId: number;
  position: number;
  referenceNames: string[];
  onDelete: () => void;
  onRegenerate: () => void;
  onInsertAfter: () => void;
  onClick: () => void;
  onIterativeEdit?: () => void;
  onRatingChange?: () => void;
}

export function PanelCard({
  panel,
  projectId,
  position,
  referenceNames,
  onDelete,
  onRegenerate,
  onInsertAfter,
  onClick,
  onIterativeEdit,
  onRatingChange,
}: PanelCardProps) {
  const { imageUrl, prompt, status, errorMessage } = panel;
  const utils = trpc.useUtils();

  const isActive = status === 'Generating' || status === 'Pending' || status === 'Enqueued';

  // Patch this panel's data directly in the getProject cache (no full refetch needed)
  const patchPanel = useCallback(
    (update: { status: string; imageUrl?: string | null }) => {
      utils.comics.getProject.setData({ id: projectId }, (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          chapters: prev.chapters.map((ch) => ({
            ...ch,
            panels: ch.panels.map((p) =>
              p.id === panel.id
                ? { ...p, status: update.status as ComicPanelStatus, imageUrl: update.imageUrl ?? p.imageUrl }
                : p
            ),
          })),
        };
      });
    },
    [utils, projectId, panel.id]
  );

  // Poll server to check orchestrator status and download image when ready
  const pollOnce = useCallback(async () => {
    try {
      console.log('Start polling panel status for panel', panel.id);
      const result = await utils.comics.pollPanelStatus.fetch({ panelId: panel.id }, {
        cacheTime: 0,
        
      });
      console.log('Polled panel status for panel', panel.id, ':', result);
      if (result.status === 'Ready' || result.status === 'Failed') {
        patchPanel({ status: result.status, imageUrl: result.imageUrl });
      }
    } catch {
      /* ignore */
    }
  }, [utils, panel.id, patchPanel]);

  // Self-contained polling: when this panel is actively generating, poll every 5s
  useEffect(() => {
    if (!isActive) return;
    void pollOnce();
    const interval = setInterval(pollOnce, 25_000);
    return () => clearInterval(interval);
  }, [isActive, pollOnce]);

  // Listen for ComicPanelUpdate signal targeting this specific panel
  useSignalConnection(
    SignalMessages.ComicPanelUpdate,
    useCallback(
      (data: { panelId: number; projectId: number; status: string; imageUrl?: string }) => {
        if (data.panelId !== panel.id) return;
        if (data.status === 'Ready' || data.status === 'Failed') {
          patchPanel({ status: data.status, imageUrl: data.imageUrl });
        }
      },
      [panel.id, patchPanel]
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
        console.log('Received TextToImageUpdate signal for panel', panel.id, 'with status', data.status);
        void pollOnce();
      },
      [isActive, panel.workflowId, pollOnce]
    )
  );

  const nsfwInfo = panel.image?.nsfwLevel ? getNsfwLabel(panel.image.nsfwLevel) : null;

  const promptPreview = prompt?.length > 80 ? `${prompt.slice(0, 80)}...` : prompt;

  return (
    <Tooltip label={promptPreview} disabled={!prompt} withArrow position="top" multiline maw={300} openDelay={400}>
    <div className={styles.panelCard} onClick={onClick}>
      {imageUrl ? (
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
      ) : (
        <>
          {status === 'Generating' || status === 'Pending' || status === 'Enqueued' ? (
            <div className={styles.panelEmpty}>
              <div className={styles.spinner} />
              <Text size="xs">{status === 'Pending' || status === 'Enqueued' ? 'Queued' : 'Generating...'}</Text>
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
