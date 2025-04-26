import {
  ActionIcon,
  AspectRatio,
  Badge,
  Box,
  Group,
  HoverCard,
  Indicator,
  LoadingOverlay,
  Menu,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { CollectionType, ModelStatus } from '~/shared/utils/prisma/enums';
import {
  IconBrush,
  IconDotsVertical,
  IconDownload,
  IconFlag,
  IconMessageCircle2,
  IconTagOff,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useRouter } from 'next/router';
import React, { useEffect, useState } from 'react';

import { CivitaiLinkManageButton } from '~/components/CivitaiLink/CivitaiLinkManageButton';
import { CivitaiTooltip } from '~/components/CivitaiWrapped/CivitaiTooltip';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { HideModelButton } from '~/components/HideModelButton/HideModelButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { AddToCollectionMenuItem } from '~/components/MenuItems/AddToCollectionMenuItem';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useHiddenPreferencesContext } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { constants } from '~/server/common/constants';
import { ReportEntity } from '~/server/schema/report.schema';
import { isFutureDate } from '~/utils/date-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getDisplayName, slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { AddToShowcaseMenuItem } from '~/components/Profile/AddToShowcaseMenuItem';
import { ToggleSearchableMenuItem } from '../../MenuItems/ToggleSearchableMenuItem';
import type { AssociatedResourceModelCardData } from '~/server/controllers/model.controller';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { isDefined } from '~/utils/type-guards';
import { useModelCardContextMenu } from '~/components/Model/Actions/ModelCardContextMenu';
import { openReportModal } from '~/components/Dialog/dialog-registry';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import styles from './ModelCategoryCard.module.scss';

const aDayAgo = dayjs().subtract(1, 'day').toDate();

export function ModelCategoryCard({
  data,
  ...props
}: ElementDataAttributes & {
  data: AssociatedResourceModelCardData;
  height: number;
}) {
  const router = useRouter();
  const modelId = router.query.model ? Number(router.query.model) : undefined;
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  const [loading, setLoading] = useState(false);

  const { id, images, name, rank, user, earlyAccessDeadline } = data;
  const image = images[0];
  const inEarlyAccess = earlyAccessDeadline && isFutureDate(earlyAccessDeadline);
  const isNew = data.publishedAt && data.publishedAt > aDayAgo;
  const isUpdated =
    data.lastVersionAt &&
    data.publishedAt &&
    data.lastVersionAt > aDayAgo &&
    data.lastVersionAt.getTime() - data.publishedAt.getTime() > constants.timeCutOffs.updatedModel;

  const { data: { Recommended: reviewedModels = [] } = { Recommended: [], Hide: [] } } =
    trpc.user.getEngagedModels.useQuery(undefined, {
      enabled: !!currentUser,
      cacheTime: Infinity,
      staleTime: Infinity,
    });
  const hasReview = reviewedModels.includes(id);
  const { hiddenUsers: hiddenUsers, hiddenModels: hiddenModels } = useHiddenPreferencesContext();
  const isHidden = hiddenUsers.get(user.id) || hiddenModels.get(id);
  const { setMenuItems } = useModelCardContextMenu();

  const modelText = <Text className={styles.title}>{name}</Text>;

  const modelBadges = (
    <>
      <Badge className={`${styles.floatingBadge} ${styles.typeBadge}`} radius="sm" size="sm">
        {getDisplayName(data.type)}
      </Badge>
      {data.status !== ModelStatus.Published && (
        <Badge className={`${styles.floatingBadge} ${styles.statusBadge}`} radius="sm" size="sm">
          {data.status}
        </Badge>
      )}
      {data.status === ModelStatus.Published && inEarlyAccess && (
        <Badge
          className={`${styles.floatingBadge} ${styles.earlyAccessBadge}`}
          radius="sm"
          size="sm"
        >
          Early Access
        </Badge>
      )}
    </>
  );

  const modelDownloads = (
    <IconBadge className={styles.statBadge} icon={<IconDownload size={14} />}>
      <Text size={12}>{abbreviateNumber(rank.downloadCount)}</Text>
    </IconBadge>
  );

  const modelLikes = !!rank.thumbsUpCount && (
    <IconBadge
      className={styles.statBadge}
      icon={
        <Text color={hasReview ? 'success.5' : undefined} inline>
          <ThumbsUpIcon size={14} filled={hasReview} />
        </Text>
      }
      color={hasReview ? 'success.5' : 'gray'}
    >
      <Text size="xs">{abbreviateNumber(rank.thumbsUpCount)}</Text>
    </IconBadge>
  );

  const modelComments = !!rank.commentCount && (
    <IconBadge className={styles.statBadge} icon={<IconMessageCircle2 size={14} />}>
      <Text size="xs">{abbreviateNumber(rank.commentCount)}</Text>
    </IconBadge>
  );

  const reportOption = {
    key: 'report-model',
    component: (
      <LoginRedirect reason="report-model" key="report">
        <Menu.Item
          icon={<IconFlag size={14} stroke={1.5} />}
          onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
            e.preventDefault();
            e.stopPropagation();
            openReportModal({ entityType: ReportEntity.Model, entityId: id });
          }}
        >
          Report Resource
        </Menu.Item>
      </LoginRedirect>
    ),
  };

  const reportImageOption = image
    ? {
        key: 'report-content',
        component: (
          <LoginRedirect reason="report-content" key="report-image">
            <Menu.Item
              icon={<IconFlag size={14} stroke={1.5} />}
              onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                e.preventDefault();
                e.stopPropagation();
                openReportModal({ entityType: ReportEntity.Image, entityId: image.id });
              }}
            >
              Report Image
            </Menu.Item>
          </LoginRedirect>
        ),
      }
    : null;

  const blockTagsOption = {
    key: 'block-tags',
    component: (
      <Menu.Item
        key="block-tags"
        icon={<IconTagOff size={14} stroke={1.5} />}
        onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
          e.preventDefault();
          e.stopPropagation();
          openContext('blockModelTags', { modelId: id });
        }}
      >
        {`Hide content with these tags`}
      </Menu.Item>
    ),
  };

  let contextMenuItems: { key: string; component: React.ReactNode }[] = [];
  if (features.collections) {
    contextMenuItems.push({
      key: 'add-to-collection',
      component: (
        <AddToCollectionMenuItem
          key="add-to-collection"
          onClick={() =>
            openContext('addToCollection', { modelId: data.id, type: CollectionType.Model })
          }
        />
      ),
    });
  }

  contextMenuItems.push({
    component: (
      <ToggleSearchableMenuItem
        entityType="Model"
        entityId={data.id}
        key="toggle-searchable-menu-item"
      />
    ),
    key: 'toggle-searchable-menu-item',
  });

  if (currentUser?.id === user.id) {
    contextMenuItems.push({
      key: 'add-to-showcase',
      component: (
        <AddToShowcaseMenuItem key="add-to-showcase" entityType="Model" entityId={data.id} />
      ),
    });
  }

  if (currentUser?.id !== user.id) {
    contextMenuItems.push(
      ...[
        {
          key: 'hide-model',
          component: <HideModelButton key="hide-model" as="menu-item" modelId={id} />,
        },
        {
          key: 'hide-button',
          component: <HideUserButton key="hide-button" as="menu-item" userId={user.id} />,
        },
        reportOption,
        reportImageOption,
      ].filter(isDefined)
    );
  }

  if (currentUser) contextMenuItems.splice(2, 0, blockTagsOption);

  if (setMenuItems) {
    contextMenuItems = setMenuItems(data, contextMenuItems);
  }

  useEffect(() => {
    if (!modelId || modelId !== data.id) return;
    const elem = document.getElementById(`${modelId}`);
    if (elem) elem.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
  }, [modelId, data.id]);

  return (
    <MasonryCard
      {...props}
      className={styles.root}
      component={Link}
      href={`/models/${id}/${slugit(name)}`}
    >
      <div className={styles.image}>
        {image && <EdgeMedia src={image.url} alt={name} width={450} className={styles.image} />}
        <div className={styles.overlay} />
        <div className={styles.content}>
          {modelText}
          <div className={styles.stats}>
            {modelDownloads}
            {modelLikes}
            {modelComments}
          </div>
        </div>
        {modelBadges}
        <div className={styles.actions}>
          <ActionIcon className={styles.actionButton}>
            <IconDotsVertical size={16} />
          </ActionIcon>
        </div>
      </div>
    </MasonryCard>
  );
}

