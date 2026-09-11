import { NavLink, Text, ThemeIcon } from '@mantine/core';
import clsx from 'clsx';
import { createElement } from 'react';
import { QueueCountBadge } from '~/components/Placement/QueueCountBadge';
import type { CollectionListView } from './collection-list.utils';
import { collectionTypeData } from './collection.utils';
import type { CollectionGetAllUserModel } from '~/types/router';
import classes from './MyCollections.module.scss';

export function CollectionListRow({
  collection,
  view,
  isActive,
  roleLabel,
  onClick,
  pendingReviewCount,
}: {
  collection: CollectionGetAllUserModel;
  view: CollectionListView;
  isActive: boolean;
  roleLabel: string | null;
  onClick: () => void;
  pendingReviewCount?: number;
}) {
  const typeData = collection.type ? collectionTypeData[collection.type] : undefined;
  const meta = [typeData?.label, roleLabel].filter(Boolean).join(' · ');

  return (
    <NavLink
      radius="sm"
      active={isActive}
      onClick={onClick}
      className={clsx(classes.navLinkWrapper, view === 'default' && classes.rowDefault)}
      leftSection={
        view === 'default' && typeData ? (
          <ThemeIcon size={18} variant="subtle" color={typeData.color} className={classes.rowIcon}>
            {createElement(typeData.icon, { size: 15 })}
          </ThemeIcon>
        ) : undefined
      }
      label={
        view === 'compact' ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <Text size="sm" lineClamp={1} inherit>
              {collection.name}
            </Text>
            <QueueCountBadge count={pendingReviewCount ?? 0} max={99} />
            {typeData && (
              <Text size="sm" c="dimmed" className="shrink-0">
                • {typeData.label}
              </Text>
            )}
          </span>
        ) : (
          <span className="flex min-w-0 flex-col">
            {/* The badge rides the name line rather than the row's right edge: the row is a flex
                box whose only flexible child is the name, so an edge-pinned badge is what gets
                squeezed when a title is long. */}
            <span className="flex min-w-0 items-center gap-1.5">
              <Text size="sm" lineClamp={1} inherit>
                {collection.name}
              </Text>
              <QueueCountBadge count={pendingReviewCount ?? 0} max={99} />
            </span>
            {meta && (
              <Text fz={11} c="dimmed" className={classes.rowMeta}>
                {meta}
              </Text>
            )}
          </span>
        )
      }
    />
  );
}
