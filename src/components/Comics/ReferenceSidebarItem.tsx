import { ActionIcon, Badge, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconTrash, IconUser } from '@tabler/icons-react';
import clsx from 'clsx';
import Link from 'next/link';
import { refTypeBadge } from '~/components/Comics/comic-project-constants';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import styles from '~/pages/comics/project/[id]/ProjectWorkspace.module.scss';

export function ReferenceSidebarItem({
  character: ref,
  projectId,
  referenceImageMap,
  onDelete,
  getStatusDotClass,
  getStatusLabel,
}: {
  character: { id: number; name: string; status: string; type?: string; images?: any[] };
  projectId: number;
  referenceImageMap: Map<number, { url: string }>;
  onDelete: (id: number, name: string) => void;
  getStatusDotClass: (status: string, hasRefs: boolean) => string;
  getStatusLabel: (status: string, hasRefs: boolean, isFailed: boolean) => string;
}) {
  const coverImage = referenceImageMap.get(ref.id);
  const imageCount = ref.images?.length ?? 0;
  const hasImages = imageCount > 0;
  const isFailed = ref.status === 'Failed';
  const refType = ref.type ?? 'Character';
  const tooltipLabel = `${refType} · ${imageCount} image${imageCount !== 1 ? 's' : ''}`;

  return (
    <Tooltip label={tooltipLabel} withArrow position="right" openDelay={300}>
    <Link
      href={`/comics/project/${projectId}/character?characterId=${ref.id}`}
      className={styles.characterCard}
      style={{ textDecoration: 'none' }}
    >
      <div className={styles.characterAvatar}>
        {isFailed ? (
          <IconAlertTriangle size={18} style={{ color: '#fa5252' }} />
        ) : coverImage ? (
          <EdgeMedia2
            src={coverImage.url}
            type="image"
            name={ref.name}
            alt={ref.name}
            width={80}
            style={{
              maxWidth: '100%',
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'top center',
              display: 'block',
            }}
          />
        ) : (
          <IconUser size={18} style={{ color: '#909296' }} />
        )}
      </div>

      <div className={styles.characterInfo}>
        <div className="flex items-center gap-1">
          <span className={styles.characterName}>
            {ref.name}
          </span>
          {ref.type && ref.type !== 'Character' && refTypeBadge[ref.type] && (
            <Badge size="xs" variant="light" color={refTypeBadge[ref.type].color}>
              {refTypeBadge[ref.type].label}
            </Badge>
          )}
        </div>
        <p className={styles.characterStatus}>
          <span className={clsx(styles.statusDot, getStatusDotClass(ref.status, hasImages))} />
          {getStatusLabel(ref.status, hasImages, isFailed)}
        </p>
      </div>

      <div className={styles.characterDelete}>
        <ActionIcon
          variant="subtle"
          color="red"
          size="sm"
          onClick={(e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete(ref.id, ref.name);
          }}
        >
          <IconTrash size={14} />
        </ActionIcon>
      </div>
    </Link>
    </Tooltip>
  );
}
