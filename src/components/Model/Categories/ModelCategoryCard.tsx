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
import dayjs from '~/shared/utils/dayjs';
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
import {
  openAddToCollectionModal,
  openBlockModelTagsModal,
  openReportModal,
} from '~/components/Dialog/dialog-registry';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import classes from './ModelCategoryCard.module.scss';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

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

  const modelText = (
    <Text fz={14} fw={500} c="white" style={{ flex: 1, lineHeight: 1 }}>
      {name}
    </Text>
  );

  const modelBadges = (
    <>
      <Badge className={clsx(classes.floatingBadge, classes.typeBadge)} radius="sm" size="sm">
        {getDisplayName(data.type)}
      </Badge>
      {data.status !== ModelStatus.Published && (
        <Badge className={clsx(classes.floatingBadge, classes.statusBadge)} radius="sm" size="sm">
          {data.status}
        </Badge>
      )}
      {data.status === ModelStatus.Published && inEarlyAccess && (
        <Badge
          className={clsx(classes.floatingBadge, classes.earlyAccessBadge)}
          radius="sm"
          size="sm"
        >
          Early Access
        </Badge>
      )}
    </>
  );

  const modelDownloads = (
    <IconBadge className={classes.statBadge} icon={<IconDownload size={14} />}>
      <Text fz={12}>{abbreviateNumber(rank.downloadCount)}</Text>
    </IconBadge>
  );

  const modelLikes = !!rank.thumbsUpCount && (
    <IconBadge
      className={classes.statBadge}
      icon={
        <Text c={hasReview ? 'success.5' : undefined} inline>
          <ThumbsUpIcon size={14} filled={hasReview} />
        </Text>
      }
      color={hasReview ? 'success.5' : 'gray'}
    >
      <Text size="xs">{abbreviateNumber(rank.thumbsUpCount)}</Text>
    </IconBadge>
  );

  const modelComments = !!rank.commentCount && (
    <IconBadge className={classes.statBadge} icon={<IconMessageCircle2 size={14} />}>
      <Text size="xs">{abbreviateNumber(rank.commentCount)}</Text>
    </IconBadge>
  );

  const reportOption = {
    key: 'report-model',
    component: (
      <LoginRedirect reason="report-model" key="report">
        <Menu.Item
          leftSection={<IconFlag size={14} stroke={1.5} />}
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
              leftSection={<IconFlag size={14} stroke={1.5} />}
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
        leftSection={<IconTagOff size={14} stroke={1.5} />}
        onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
          e.preventDefault();
          e.stopPropagation();
          openBlockModelTagsModal({ props: { modelId: id } });
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
            openAddToCollectionModal({ props: { modelId: data.id, type: CollectionType.Model } })
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
    <MasonryCard shadow="sm" {...props} className={classes.card}>
      <Indicator
        disabled={!isNew && !isUpdated}
        size={24}
        radius="sm"
        label={isUpdated ? 'Updated' : 'New'}
        color="red"
        styles={{ indicator: { zIndex: 10, transform: 'translate(5px,-5px) !important' } }}
        style={{ opacity: isHidden ? 0.1 : undefined }}
        withBorder
      >
        <Link
          href={`/models/${id}/${slugit(name)}`}
          className={classes.link}
          onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
            if (!(e.ctrlKey || e.metaKey) && e.button !== 1) setLoading(true);
          }}
          // style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        >
          <LoadingOverlay visible={loading} zIndex={9} loaderProps={{ variant: 'dots' }} />
          {image && (
            <ImageGuard2 image={image} connectType="model" connectId={id}>
              {(safe) => (
                <>
                  {contextMenuItems.length > 0 && (
                    <Menu position="left-start" withArrow offset={-5}>
                      <Menu.Target>
                        <LegacyActionIcon
                          variant="transparent"
                          p={0}
                          onClick={(e: React.MouseEvent) => {
                            e.preventDefault();
                            e.stopPropagation();
                          }}
                          style={{
                            width: 30,
                            position: 'absolute',
                            top: 10,
                            right: 4,
                            zIndex: 8,
                          }}
                        >
                          <IconDotsVertical
                            size={24}
                            color="#fff"
                            style={{ filter: `drop-shadow(0 0 2px #000)` }}
                          />
                        </LegacyActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        {contextMenuItems.map((el) => (
                          <React.Fragment key={el.key}>{el.component}</React.Fragment>
                        ))}
                      </Menu.Dropdown>
                    </Menu>
                  )}
                  <Group gap={4} className={classes.cardBadges}>
                    <ImageGuard2.BlurToggle />
                    {modelBadges}
                  </Group>
                  <AspectRatio ratio={1} style={{ width: '100%', overflow: 'hidden' }}>
                    <div className={classes.blur}>
                      <MediaHash {...image} />
                    </div>
                    {safe && (
                      <EdgeMedia
                        className={classes.image}
                        src={image.url}
                        name={image.name ?? image.id.toString()}
                        alt={image.name ?? undefined}
                        type={image.type}
                        width={450}
                        placeholder="empty"
                      />
                    )}
                  </AspectRatio>
                </>
              )}
            </ImageGuard2>
          )}

          <Stack className={classes.info} gap={8}>
            <Group
              mx="xs"
              justify="space-between"
              style={{
                zIndex: 10,
              }}
            >
              <Group gap={8}>
                <CivitaiLinkManageButton
                  modelId={id}
                  modelName={name}
                  modelType={data.type}
                  hashes={data.hashes}
                  tooltipProps={{
                    position: 'right',
                    transitionProps: {
                      transition: 'slide-right',
                    },
                    variant: 'smallRounded',
                  }}
                >
                  {({ color, onClick, ref, icon }) => (
                    <LegacyActionIcon
                      component="button"
                      className={classes.hoverable}
                      ref={ref}
                      radius="lg"
                      variant="filled"
                      size="lg"
                      color={color}
                      onClick={onClick}
                    >
                      {icon}
                    </LegacyActionIcon>
                  )}
                </CivitaiLinkManageButton>
                {features.imageGeneration && data.canGenerate && (
                  <HoverCard width={200} withArrow>
                    <HoverCard.Target>
                      <ThemeIcon className={classes.hoverable} size={38} radius="xl" color="green">
                        <IconBrush stroke={2.5} size={22} />
                      </ThemeIcon>
                    </HoverCard.Target>
                    <HoverCard.Dropdown>
                      <Stack gap={4}>
                        <Text size="sm" fw="bold">
                          Available for generation
                        </Text>
                        <Text size="sm" c="dimmed">
                          This resource has versions available for image generation
                        </Text>
                      </Stack>
                    </HoverCard.Dropdown>
                  </HoverCard>
                )}
              </Group>
              {data.user.image && (
                <CivitaiTooltip
                  position="left"
                  transitionProps={{ transition: 'slide-left' }}
                  variant="smallRounded"
                  label={
                    <Text size="xs" fw={500}>
                      {data.user.username}
                    </Text>
                  }
                >
                  <Box
                    style={{ borderRadius: '50%' }}
                    onClick={(e: React.MouseEvent<HTMLDivElement>) => {
                      e.preventDefault();
                      e.stopPropagation();
                      router.push(`/user/${data.user.username}`);
                    }}
                    ml="auto"
                  >
                    <UserAvatar
                      size="md"
                      user={data.user}
                      avatarProps={{ className: classes.userAvatar }}
                    />
                  </Box>
                </CivitaiTooltip>
              )}
            </Group>

            <Stack className={classes.content} gap={6} p="xs">
              <Group justify="start" gap={4}>
                {modelText}
              </Group>
              <Group justify="space-between" gap={4}>
                <Group gap={4} align="center">
                  {modelLikes}
                  {modelComments}
                  {modelDownloads}
                </Group>
              </Group>
            </Stack>
          </Stack>
        </Link>
      </Indicator>
    </MasonryCard>
  );
}
