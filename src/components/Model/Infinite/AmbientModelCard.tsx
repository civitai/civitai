import {
  ActionIcon,
  AspectRatio,
  Badge,
  Box,
  createStyles,
  Group,
  HoverCard,
  Indicator,
  LoadingOverlay,
  Menu,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { CollectionType, ModelStatus, CosmeticType } from '~/shared/utils/prisma/enums';
import {
  IconBrush,
  IconDownload,
  IconMessageCircle2,
  IconFlag,
  IconTagOff,
  IconDotsVertical,
  IconInfoCircle,
  IconBolt,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useRouter } from 'next/router';
import React, { useState, useEffect } from 'react';

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
import { UseQueryModelReturn } from '~/components/Model/model.utils';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { env } from '~/env/client.mjs';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { BaseModel, baseModelSets, constants } from '~/server/common/constants';
import { ReportEntity } from '~/server/schema/report.schema';
import { isFutureDate } from '~/utils/date-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { slugit, getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';
import { useModelCardContext } from '~/components/Cards/ModelCardContext';
import { useInView } from '~/hooks/useInView';
import { HolidayFrame } from '~/components/Decorations/HolidayFrame';
import { truncate } from 'lodash-es';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { ToggleSearchableMenuItem } from '../../MenuItems/ToggleSearchableMenuItem';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { getIsSdxl } from '~/shared/constants/generation.constants';
import { openReportModal } from '~/components/Dialog/dialog-registry';

const useStyles = createStyles((theme, _, getRef) => {
  const infoRef = getRef('info');

  return {
    card: {
      // height: '300px',
      // background: theme.fn.gradient({ from: base[9], to: background, deg: 180 }),
      // [`&:has(~ .frame-decor) .${infoRef}`]: {
      //   paddingBottom: '28px !important',
      // },
    },
    link: {
      display: 'block',
    },

    content: {
      background: theme.fn.gradient({
        from: 'rgba(37,38,43,0.8)',
        to: 'rgba(37,38,43,0)',
        deg: 0,
      }),
      // backdropFilter: 'blur(13px) saturate(160%)',
      boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
    },

    info: {
      ref: infoRef,
      position: 'absolute',
      bottom: 0,
      right: 0,
      left: 0,
      zIndex: 10,
    },

    cardBadges: {
      position: 'absolute',
      top: theme.spacing.xs,
      left: theme.spacing.xs,
      zIndex: 10,
    },

    typeBadge: {
      background: 'rgb(30 133 230 / 40%)',
    },

    floatingBadge: {
      color: 'white',
      // backdropFilter: 'blur(7px)',
      boxShadow: '1px 2px 3px -1px rgba(37,38,43,0.2)',
    },

    statusBadge: {
      background: theme.fn.rgba(theme.colors.yellow[theme.fn.primaryShade()], 0.4),
    },

    earlyAccessBadge: {
      background: theme.fn.rgba(theme.colors.green[theme.fn.primaryShade()], 0.4),
    },

    floatingAvatar: {
      position: 'absolute',
      bottom: theme.spacing.xs,
      right: theme.spacing.xs,
      zIndex: 10,
    },

    statBadge: {
      background: 'rgba(212,212,212,0.2)',
      color: 'white',
    },

    userAvatar: {
      opacity: 0.8,
      boxShadow: '0 1px 3px rgb(0 0 0 / 50%), rgb(0 0 0 / 50%) 0px 8px 15px -5px',
      transition: 'opacity .25s ease',
      position: 'relative',

      '&::before': {
        content: '""',
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        borderRadius: theme.radius.xl,
        boxShadow: 'inset 0 0 0px 1px rgba(255,255,255,0.8)',
      },

      '&:hover': {
        opacity: 1,
      },
    },

    hoverable: {
      opacity: 0.8,
      boxShadow: '0 1px 3px rgb(0 0 0 / 50%), rgb(0 0 0 / 50%) 0px 8px 15px -5px',
      transition: 'opacity .25s ease',
      position: 'relative',
      '&:hover': {
        opacity: 1,
      },
    },
  };
});

const aDayAgo = dayjs().subtract(1, 'day').toDate();

export function AmbientModelCard({ data, height }: Props) {
  const { ref, inView } = useInView({ rootMargin: '600px' });
  const router = useRouter();
  const modelId = router.query.model ? Number(router.query.model) : undefined;
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();
  const { push } = useRouter();
  const features = useFeatureFlags();
  const tippedAmount = useBuzzTippingStore({ entityType: 'Model', entityId: data.id });

  const { id, images, name, rank, user, locked, earlyAccessDeadline } = data ?? {};
  const inEarlyAccess = earlyAccessDeadline && isFutureDate(earlyAccessDeadline);
  const image = images[0];

  const [loading, setLoading] = useState(false);

  const { data: { Recommended: reviewedModels = [] } = { Recommended: [], Hide: [] } } =
    trpc.user.getEngagedModels.useQuery(undefined, {
      enabled: !!currentUser,
      cacheTime: Infinity,
      staleTime: Infinity,
    });
  const hasReview = reviewedModels.includes(id);

  const modelText = (
    <Text size={14} weight={500} color="white" style={{ flex: 1, lineHeight: 1 }}>
      {name}
    </Text>
  );

  const isSDXL = getIsSdxl(data.version.baseModel);
  const modelBadges = (
    <>
      <Badge className={cx(classes.floatingBadge, classes.typeBadge)} radius="sm" size="sm">
        {getDisplayName(data.type)} {isSDXL && 'XL'}
      </Badge>
      {data.status !== ModelStatus.Published && (
        <Badge className={cx(classes.floatingBadge, classes.statusBadge)} radius="sm" size="sm">
          {data.status}
        </Badge>
      )}
      {data.status === ModelStatus.Published && inEarlyAccess && (
        <Badge
          className={cx(classes.floatingBadge, classes.earlyAccessBadge)}
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
      <Text size={12}>{abbreviateNumber(rank.downloadCount)}</Text>
    </IconBadge>
  );

  const modelBuzz = (
    <InteractiveTipBuzzButton toUserId={data.user.id} entityType={'Model'} entityId={data.id}>
      <IconBadge className={classes.statBadge} icon={<IconBolt size={14} />}>
        <Text size="xs">{abbreviateNumber(data.rank.tippedAmountCount + tippedAmount)}</Text>
      </IconBadge>
    </InteractiveTipBuzzButton>
  );

  const modelLikes = !!rank.thumbsUpCount && (
    <IconBadge
      className={classes.statBadge}
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
    <IconBadge className={classes.statBadge} icon={<IconMessageCircle2 size={14} />}>
      <Text size="xs">{abbreviateNumber(rank.commentCount)}</Text>
    </IconBadge>
  );

  const reportOption = (
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
  );

  const reportImageOption = image && (
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
  );

  const blockTagsOption = (
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
  );

  let contextMenuItems: React.ReactNode[] = [];
  if (features.collections) {
    contextMenuItems = contextMenuItems.concat([
      <AddToCollectionMenuItem
        key="add-to-collection"
        onClick={() =>
          openContext('addToCollection', { modelId: data.id, type: CollectionType.Model })
        }
      />,
    ]);
  }
  contextMenuItems = contextMenuItems.concat([
    <ToggleSearchableMenuItem
      entityType="Model"
      entityId={data.id}
      key="toggle-searchable-menu-item"
    />,
  ]);

  if (currentUser?.id !== user.id)
    contextMenuItems = contextMenuItems.concat([
      <HideModelButton key="hide-model" as="menu-item" modelId={id} />,
      <HideUserButton key="hide-button" as="menu-item" userId={user.id} />,
      reportOption,
      reportImageOption,
    ]);
  if (currentUser) contextMenuItems.splice(2, 0, blockTagsOption);

  if (currentUser?.isModerator && env.NEXT_PUBLIC_MODEL_LOOKUP_URL) {
    contextMenuItems.unshift(
      <Menu.Item
        component="a"
        key="lookup-model"
        target="_blank"
        icon={<IconInfoCircle size={14} stroke={1.5} />}
        href={`${env.NEXT_PUBLIC_MODEL_LOOKUP_URL}${data.id}`}
        onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
          e.preventDefault();
          e.stopPropagation();
          window.open(`${env.NEXT_PUBLIC_MODEL_LOOKUP_URL}${data.id}`, '_blank');
        }}
      >
        Lookup Model
      </Menu.Item>
    );
  }

  const isNew = data.publishedAt && data.publishedAt > aDayAgo;
  const isUpdated =
    data.lastVersionAt &&
    data.publishedAt &&
    data.lastVersionAt > aDayAgo &&
    data.lastVersionAt.getTime() - data.publishedAt.getTime() > constants.timeCutOffs.updatedModel;

  const { useModelVersionRedirect } = useModelCardContext();
  let href = `/models/${data.id}/${slugit(data.name)}`;
  if (useModelVersionRedirect) href += `?modelVersionId=${data.version.id}`;

  useEffect(() => {
    if (!modelId || modelId !== data.id) return;
    const elem = document.getElementById(`${modelId}`);
    if (elem) elem.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
  }, [modelId, data.id]);

  const cardDecoration = data.user.cosmetics?.find(
    ({ cosmetic }) => cosmetic.type === CosmeticType.ContentDecoration
  ) as (typeof data.user.cosmetics)[number] & {
    data?: { lights?: number; upgradedLights?: number };
  };

  return (
    <HolidayFrame {...cardDecoration}>
      <Indicator
        disabled={!isNew && !isUpdated}
        withBorder
        size={24}
        radius="sm"
        label={isUpdated ? 'Updated' : 'New'}
        color="red"
        className={classes.card}
        styles={{ indicator: { zIndex: 10, transform: 'translate(5px,-5px) !important' } }}
      >
        <MasonryCard
          ref={ref}
          withBorder
          shadow="sm"
          height={height}
          p={0}
          frameDecoration={data.cosmetic}
        >
          {inView && (
            <NextLink
              href={href}
              className={classes.link}
              style={{ height }}
              onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
                if (!(e.ctrlKey || e.metaKey) && e.button !== 1) setLoading(true);
              }}
            >
              {/* <Freeze freeze={!inView}> */}
              {inView && (
                <>
                  <LoadingOverlay visible={loading} zIndex={9} loaderProps={{ variant: 'dots' }} />
                  {image && (
                    <ImageGuard2 image={image} connectType="model" connectId={id}>
                      {(safe) => (
                        <Box sx={{ position: 'relative' }}>
                          {contextMenuItems.length > 0 && (
                            <Menu position="left-start" withArrow offset={-5}>
                              <Menu.Target>
                                <ActionIcon
                                  variant="transparent"
                                  p={0}
                                  onClick={(e: React.MouseEvent) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                  }}
                                  sx={{
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
                                </ActionIcon>
                              </Menu.Target>
                              <Menu.Dropdown>
                                {contextMenuItems.map((el, index) => (
                                  <React.Fragment key={index}>{el}</React.Fragment>
                                ))}
                              </Menu.Dropdown>
                            </Menu>
                          )}
                          <Group spacing={4} className={classes.cardBadges}>
                            <ImageGuard2.BlurToggle />
                            {modelBadges}
                          </Group>
                          {!safe ? (
                            <AspectRatio ratio={(image?.width ?? 1) / (image?.height ?? 1)}>
                              <MediaHash {...image} />
                            </AspectRatio>
                          ) : (
                            <EdgeMedia
                              src={image.url}
                              name={image.name ?? image.id.toString()}
                              alt={image.name ?? undefined}
                              type={image.type}
                              width={450}
                              placeholder="empty"
                              style={{ width: '100%', zIndex: 2, position: 'relative' }}
                            />
                          )}
                        </Box>
                      )}
                    </ImageGuard2>
                  )}
                  <Stack className={classes.info} spacing={8}>
                    <Group
                      mx="xs"
                      position="apart"
                      sx={{
                        zIndex: 10,
                      }}
                    >
                      <Group spacing={8}>
                        <CivitaiLinkManageButton
                          modelId={id}
                          modelName={name}
                          modelType={data.type}
                          hashes={data.hashes}
                          tooltipProps={{
                            position: 'right',
                            transition: 'slide-right',
                            variant: 'smallRounded',
                          }}
                        >
                          {({ color, onClick, ref, icon }) => (
                            <ActionIcon
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
                            </ActionIcon>
                          )}
                        </CivitaiLinkManageButton>
                        {features.imageGeneration && data.canGenerate && (
                          <HoverCard width={200} withArrow>
                            <HoverCard.Target>
                              <ThemeIcon
                                className={classes.hoverable}
                                size={38}
                                radius="xl"
                                color="green"
                              >
                                <IconBrush stroke={2.5} size={22} />
                              </ThemeIcon>
                            </HoverCard.Target>
                            <HoverCard.Dropdown>
                              <Stack spacing={4}>
                                <Text size="sm" weight="bold">
                                  Available for generation
                                </Text>
                                <Text size="sm" color="dimmed">
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
                          transition="slide-left"
                          variant="smallRounded"
                          label={
                            <Text size="xs" weight={500}>
                              {data.user.username}
                            </Text>
                          }
                        >
                          <Box
                            sx={{
                              borderRadius: '50%',
                            }}
                            onClick={(e: React.MouseEvent<HTMLDivElement>) => {
                              e.preventDefault();
                              e.stopPropagation();
                              push(`/user/${data.user.username}`);
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

                    <Stack className={cx('footer', classes.content)} spacing={6} p="xs">
                      <Group position="left" spacing={4}>
                        {modelText}
                      </Group>
                      <Group position="apart" spacing={4}>
                        <Group spacing={4} align="center" ml="auto">
                          {modelLikes}
                          {modelComments}
                          {modelDownloads}
                          {modelBuzz}
                        </Group>
                      </Group>
                    </Stack>
                  </Stack>
                </>
              )}
              {/* </Freeze> */}
            </NextLink>
          )}
        </MasonryCard>
      </Indicator>
    </HolidayFrame>
  );
}

type Props = {
  index: number;
  data: UseQueryModelReturn[number];
  height: number;
};
