import { ActionIcon, Menu, Text } from '@mantine/core';
import {
  IconAlertTriangle,
  IconBug,
  IconDotsVertical,
  IconPhoto,
  IconPlus,
  IconRefreshDot,
  IconTrash,
  IconUser,
} from '@tabler/icons-react';
import { CSS } from '@dnd-kit/utilities';
import { useSortable } from '@dnd-kit/sortable';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import styles from '~/pages/comics/project/[id]/ProjectWorkspace.module.scss';

export interface PanelCardProps {
  panel: {
    id: number;
    imageUrl: string | null;
    prompt: string;
    status: string;
    errorMessage: string | null;
  };
  position: number;
  referenceNames: string[];
  onDelete: () => void;
  onViewDebug: () => void;
  onRegenerate: () => void;
  onInsertAfter: () => void;
  onClick: () => void;
}

export function PanelCard({
  panel,
  position,
  referenceNames,
  onDelete,
  onViewDebug,
  onRegenerate,
  onInsertAfter,
  onClick,
}: PanelCardProps) {
  const { imageUrl, prompt, status, errorMessage } = panel;

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
              <span className={styles.panelNumber}>#{position}</span>
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
                      leftSection={<IconBug size={14} />}
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        onViewDebug();
                      }}
                    >
                      Debug Info
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
