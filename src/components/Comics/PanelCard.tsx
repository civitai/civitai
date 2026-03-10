import { ActionIcon, Badge, Menu, Text } from '@mantine/core';
import {
  IconAlertTriangle,
  IconDotsVertical,
  IconEye,
  IconPhoto,
  IconPlus,
  IconRefreshDot,
  IconTrash,
  IconUser,
} from '@tabler/icons-react';
import { CSS } from '@dnd-kit/utilities';
import { useSortable } from '@dnd-kit/sortable';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { NsfwLevel } from '~/server/common/enums';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
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
    imageUrl: string | null;
    prompt: string;
    status: string;
    errorMessage: string | null;
    image?: { nsfwLevel: number } | null;
  };
  position: number;
  referenceNames: string[];
  onDelete: () => void;
  onRegenerate: () => void;
  onInsertAfter: () => void;
  onClick: () => void;
}

export function PanelCard({
  panel,
  position,
  referenceNames,
  onDelete,
  onRegenerate,
  onInsertAfter,
  onClick,
}: PanelCardProps) {
  const { imageUrl, prompt, status, errorMessage } = panel;
  const nsfwInfo = panel.image?.nsfwLevel ? getNsfwLabel(panel.image.nsfwLevel) : null;

  return (
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
                  <Badge size="xs" color={nsfwInfo.color} variant="filled">
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
                <div className="flex flex-wrap gap-1">
                  {referenceNames.map((name) => (
                    <span key={name} className={styles.panelCharacterPill}>
                      <IconUser size={10} />
                      {name}
                    </span>
                  ))}
                </div>
              )}
              <p className={styles.panelPrompt}>{prompt}</p>
            </div>
          </div>
        </>
      ) : (
        <>
          {status === 'Generating' || status === 'Pending' ? (
            <div className={styles.panelEmpty}>
              <div className={styles.spinner} />
              <Text size="xs">{status === 'Pending' ? 'Queued' : 'Generating...'}</Text>
            </div>
          ) : status === 'Failed' ? (
            <div className={styles.panelFailed}>
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
