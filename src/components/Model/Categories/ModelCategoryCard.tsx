import {
  ActionIcon,
  AspectRatio,
  Badge,
  Box,
  Group,
  Indicator,
  LoadingOverlay,
  Menu,
  Rating,
  Stack,
  Text,
  createStyles,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { ModelStatus } from '@prisma/client';
import {
  IconDotsVertical,
  IconDownload,
  IconFlag,
  IconHeart,
  IconMessageCircle2,
  IconStar,
  IconTagOff,
} from '@tabler/icons';
import dayjs from 'dayjs';
import { useRouter } from 'next/router';
import React, { useState } from 'react';

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
import { constants } from '~/server/common/constants';
import { ReportEntity } from '~/server/schema/report.schema';
import { ModelGetByCategoryModel } from '~/types/router';
import { isFutureDate } from '~/utils/date-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getDisplayName, slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const aDayAgo = dayjs().subtract(1, 'day').toDate();

export function ModelCategoryCard({ data }: { data: ModelGetByCategoryModel }) {
  const { classes, theme, cx } = useStyles();
  const router = useRouter();
  const currentUser = useCurrentUser();

  const [loading, setLoading] = useState(false);

  const { id, image, name, rank, user, locked, earlyAccessDeadline } = data;
  const inEarlyAccess = earlyAccessDeadline && isFutureDate(earlyAccessDeadline);
  const isNew = data.publishedAt && data.publishedAt > aDayAgo;
  const isUpdated =
    data.lastVersionAt &&
    data.publishedAt &&
    data.lastVersionAt > aDayAgo &&
    data.lastVersionAt.getTime() - data.publishedAt.getTime() > constants.timeCutOffs.updatedModel;

  const {
    data: { Favorite: favoriteModels = [], Hide: hiddenModels = [] } = { Favorite: [], Hide: [] },
  } = trpc.user.getEngagedModels.useQuery(undefined, {
    enabled: !!currentUser,
    cacheTime: Infinity,
    staleTime: Infinity,
  });
  const isFavorite = favoriteModels.find((modelId) => modelId === id);
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
      className={classes.statBadge}
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
  if (currentUser?.id !== user.id)
    contextMenuItems = contextMenuItems.concat([
      <HideModelButton key="hide-model" as="menu-item" modelId={id} />,
      <HideUserButton key="hide-button" as="menu-item" userId={user.id} />,
      reportOption,
      reportImageOption,
    ]);
  if (currentUser) contextMenuItems.splice(2, 0, blockTagsOption);

  return (
    <Indicator
      disabled={!isNew && !isUpdated}
      withBorder
      size={24}
      radius="sm"
      label={isUpdated ? 'Updated' : 'New'}
      color="red"
      styles={{ indicator: { zIndex: 10, transform: 'translate(5px,-5px) !important' } }}
      sx={{ opacity: isHidden ? 0.1 : undefined }}
    >
      <MasonryCard shadow="sm" p={0} height={320}>
        <NextLink
          href={`/models/${id}/${slugit(name)}`}
          className={classes.link}
          onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
            if (!(e.ctrlKey || e.metaKey) && e.button !== 1) setLoading(true);
          }}
        >
          <LoadingOverlay visible={loading} zIndex={9} loaderProps={{ variant: 'dots' }} />
          <ImageGuard
            images={image ? [image] : []}
            connect={{ entityId: id, entityType: 'model' }}
            render={(image) => (
              <ImageGuard.Content>
                {({ safe }) => (
                  <div className={classes.card}>
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
                    <AspectRatio ratio={1} sx={{ width: '100%', overflow: 'hidden' }}>
                      <div className={classes.blur}>
                        <MediaHash {...image} />
                      </div>
                      {safe && (
                        <EdgeImage
                          className={classes.image}
                          src={image.url}
                          name={image.name ?? image.id.toString()}
                          alt={image.name ?? undefined}
                          width={450}
                          placeholder="empty"
                        />
                      )}
                    </AspectRatio>
                  </div>
                )}
              </ImageGuard.Content>
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
                    ref={ref}
                    radius="lg"
                    variant="filled"
                    size="lg"
                    color={color}
                    sx={() => ({
                      opacity: 0.8,
                      boxShadow: '0 1px 3px rgb(0 0 0 / 50%), rgb(0 0 0 / 50%) 0px 8px 15px -5px',
                      transition: 'opacity .25s ease',
                      position: 'relative',

                      '&:hover': {
                        opacity: 1,
                      },
                    })}
                    onClick={onClick}
                  >
                    {icon}
                  </ActionIcon>
                )}
              </CivitiaLinkManageButton>
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
                    sx={{ borderRadius: '50%' }}
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
        </NextLink>
      </MasonryCard>
    </Indicator>
  );
}

const useStyles = createStyles((theme) => {
  return {
    card: {
      position: 'relative',
      [theme.fn.smallerThan('sm')]: {
        width: '100%',
      },
    },

    blur: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
    },
    image: {
      width: '100%',
      objectPosition: 'top',
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
  };
});
