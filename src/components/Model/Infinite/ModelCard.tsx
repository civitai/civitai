import {
  ActionIcon,
  AspectRatio,
  Badge,
  Box,
  createStyles,
  DefaultMantineColor,
  Group,
  HoverCard,
  Indicator,
  LoadingOverlay,
  Menu,
  Rating,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { ModelStatus } from '@prisma/client';
import {
  IconBrush,
  IconStar,
  IconDownload,
  IconHeart,
  IconMessageCircle2,
  IconFlag,
  IconTagOff,
  IconDotsVertical,
  IconPlaylistAdd,
} from '@tabler/icons-react';
import dayjs from 'dayjs';
import { useRouter } from 'next/router';
import React, { useState, useEffect } from 'react';
import { InView } from 'react-intersection-observer';

import { CivitiaLinkManageButton } from '~/components/CivitaiLink/CivitiaLinkManageButton';
import { CivitaiTooltip } from '~/components/CivitaiWrapped/CivitaiTooltip';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { HideModelButton } from '~/components/HideModelButton/HideModelButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { ReportEntity } from '~/server/schema/report.schema';
import { ModelGetAll } from '~/types/router';
import { getRandom } from '~/utils/array-helpers';
import { isFutureDate } from '~/utils/date-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { slugit, getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const mantineColors: DefaultMantineColor[] = [
  'blue',
  'cyan',
  'grape',
  'green',
  'indigo',
  'lime',
  'orange',
  'pink',
  'red',
  'teal',
  'violet',
  'yellow',
];

const useStyles = createStyles((theme) => {
  const base = theme.colors[getRandom(mantineColors)];
  const background = theme.colorScheme === 'dark' ? theme.colors.dark[6] : '#fff';

  return {
    card: {
      // height: '300px',
      // background: theme.fn.gradient({ from: base[9], to: background, deg: 180 }),
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
      backdropFilter: 'blur(13px) saturate(160%)',
      boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
    },

    info: {
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
      backdropFilter: 'blur(7px)',
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
  const router = useRouter();
  const modelId = router.query.model ? Number(router.query.model) : undefined;
  const hiddenQuery = router.query.hidden === 'true';
  const currentUser = useCurrentUser();
  const { classes, cx, theme } = useStyles();
  const { push } = useRouter();
  const features = useFeatureFlags();

  const { id, image, name, rank, user, locked, earlyAccessDeadline } = data ?? {};
  const inEarlyAccess = earlyAccessDeadline && isFutureDate(earlyAccessDeadline);

  const [loading, setLoading] = useState(false);

  const {
    data: { Favorite: favoriteModels = [], Hide: hiddenModels = [] } = { Favorite: [], Hide: [] },
  } = trpc.user.getEngagedModels.useQuery(undefined, {
    enabled: !!currentUser,
    cacheTime: Infinity,
    staleTime: Infinity,
  });
  const isFavorite = favoriteModels.find((modelId) => modelId === id);
  // TODO - hide models by user by updating query cache
  const { data: hidden = [] } = trpc.user.getHiddenUsers.useQuery(undefined, {
    enabled: !!currentUser,
    cacheTime: Infinity,
    staleTime: Infinity,
  });
  const isHidden =
    hidden.find(({ id }) => id === user.id) || hiddenModels.find((modelId) => modelId === id);

  const modelText = (
    <Text size={14} weight={500} color="white" style={{ flex: 1, lineHeight: 1 }}>
      {name}
    </Text>
  );

  const modelBadges = (
    <>
      <Badge className={cx(classes.floatingBadge, classes.typeBadge)} radius="sm" size="sm">
        {getDisplayName(data.type)}
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

  const modelRating = !locked ? (
    <IconBadge
      className={cx(classes.floatingBadge, classes.statBadge)}
      sx={{ userSelect: 'none' }}
      icon={
        <Rating
          size="xs"
          value={rank.rating}
          readOnly
          fractions={4}
          emptySymbol={
            theme.colorScheme === 'dark' ? (
              <IconStar size={14} fill="rgba(255,255,255,.3)" color="transparent" />
            ) : undefined
          }
        />
      }
    >
      <Text size="xs" color={rank.ratingCount > 0 ? undefined : 'dimmed'}>
        {abbreviateNumber(rank.ratingCount)}
      </Text>
    </IconBadge>
  ) : null;

  const modelDownloads = (
    <IconBadge className={classes.statBadge} icon={<IconDownload size={14} />}>
      <Text size={12}>{abbreviateNumber(rank.downloadCount)}</Text>
    </IconBadge>
  );

  const modelLikes = !!rank.favoriteCount && (
    <IconBadge
      className={classes.statBadge}
      icon={
        <IconHeart
          size={14}
          style={{ fill: isFavorite ? theme.colors.red[6] : undefined }}
          color={isFavorite ? theme.colors.red[6] : undefined}
        />
      }
      color={isFavorite ? 'red' : 'gray'}
    >
      <Text size="xs">{abbreviateNumber(rank.favoriteCount)}</Text>
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
          openContext('report', { entityType: ReportEntity.Model, entityId: id });
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
          openContext('report', { entityType: ReportEntity.Image, entityId: image.id });
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
      <LoginRedirect key="add-to-collection" reason="add-to-collection">
        <Menu.Item
          icon={
            <IconPlaylistAdd
              size={16}
              stroke={1.5}
              color={theme.colors.pink[theme.fn.primaryShade()]}
            />
          }
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openContext('addToCollection', { modelId: data.id });
          }}
        >
          Add to Collection
        </Menu.Item>
      </LoginRedirect>,
    ]);
  }

  if (currentUser?.id !== user.id)
    contextMenuItems = contextMenuItems.concat([
      <HideModelButton key="hide-model" as="menu-item" modelId={id} />,
      <HideUserButton key="hide-button" as="menu-item" userId={user.id} />,
      reportOption,
      reportImageOption,
    ]);
  if (currentUser) contextMenuItems.splice(2, 0, blockTagsOption);

  const isNew = data.publishedAt && data.publishedAt > aDayAgo;
  const isUpdated =
    data.lastVersionAt &&
    data.publishedAt &&
    data.lastVersionAt > aDayAgo &&
    data.lastVersionAt.getTime() - data.publishedAt.getTime() > constants.timeCutOffs.updatedModel;

  useEffect(() => {
    if (!modelId || modelId !== data.id) return;
    const elem = document.getElementById(`${modelId}`);
    if (elem) elem.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
  }, [modelId, data.id]);

  return (
    <InView rootMargin="600px">
      {({ ref, inView }) => (
        <Indicator
          disabled={!isNew && !isUpdated}
          withBorder
          size={24}
          radius="sm"
          label={isUpdated ? 'Updated' : 'New'}
          color="red"
          styles={{ indicator: { zIndex: 10, transform: 'translate(5px,-5px) !important' } }}
          sx={{ opacity: isHidden && !hiddenQuery ? 0.1 : undefined }}
        >
          <MasonryCard ref={ref} withBorder shadow="sm" height={height} p={0}>
            {inView && (
              <NextLink
                href={`/models/${id}/${slugit(name)}`}
                className={classes.link}
                style={{ height }}
                onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
                  if (!(e.ctrlKey || e.metaKey) && e.button !== 1) setLoading(true);
                }}
              >
                {/* <Freeze freeze={!inView}> */}
                {inView && (
                  <>
                    <LoadingOverlay
                      visible={loading}
                      zIndex={9}
                      loaderProps={{ variant: 'dots' }}
                    />
                    <ImageGuard
                      images={image ? [image] : []}
                      connect={{ entityId: id, entityType: 'model' }}
                      render={(image) => (
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
                            <ImageGuard.ToggleConnect position="static" />
                            {modelBadges}
                          </Group>
                          <ImageGuard.Unsafe>
                            <AspectRatio ratio={(image?.width ?? 1) / (image?.height ?? 1)}>
                              <MediaHash {...image} />
                            </AspectRatio>
                          </ImageGuard.Unsafe>
                          <ImageGuard.Safe>
                            <EdgeImage
                              src={image.url}
                              name={image.name ?? image.id.toString()}
                              alt={image.name ?? undefined}
                              width={450}
                              placeholder="empty"
                              style={{ width: '100%', zIndex: 2, position: 'relative' }}
                            />
                          </ImageGuard.Safe>
                        </Box>
                      )}
                    />
                    <Stack className={classes.info} spacing={8}>
                      <Group
                        mx="xs"
                        position="apart"
                        sx={{
                          zIndex: 10,
                        }}
                      >
                        <Group spacing={8}>
                          <CivitiaLinkManageButton
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
                          </CivitiaLinkManageButton>
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

                      <Stack className={classes.content} spacing={6} p="xs">
                        <Group position="left" spacing={4}>
                          {modelText}
                        </Group>
                        <Group position="apart" spacing={4}>
                          {modelRating}
                          <Group spacing={4} align="center">
                            {modelLikes}
                            {modelComments}
                            {modelDownloads}
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
      )}
    </InView>
  );
}

type Props = {
  index: number;
  data: ModelGetAll['items'][number];
  height: number;
};
