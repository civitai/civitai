import {
  ActionIcon,
  AspectRatio,
  Badge,
  Box,
  Card,
  createStyles,
  DefaultMantineColor,
  Group,
  Indicator,
  LoadingOverlay,
  Menu,
  Rating,
  Stack,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { ModelStatus } from '@prisma/client';
import {
  IconStar,
  IconDownload,
  IconHeart,
  IconMessageCircle2,
  IconFlag,
  IconTagOff,
  IconDotsVertical,
} from '@tabler/icons';
import dayjs from 'dayjs';
import Link from 'next/link';
import { useRouter } from 'next/router';
import React, { useState, useMemo } from 'react';
import { useInView } from 'react-intersection-observer';

import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { HideModelButton } from '~/components/HideModelButton/HideModelButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useRoutedContext } from '~/routed-context/routed-context.provider';
import { GetModelsInfiniteReturnType } from '~/server/controllers/model.controller';
import { ReportEntity } from '~/server/schema/report.schema';
import { getRandom } from '~/utils/array-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { splitUppercase, slugit } from '~/utils/string-helpers';
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

const useStyles = createStyles((theme, _params, getRef) => {
  const base = theme.colors[getRandom(mantineColors)];
  const background = theme.colorScheme === 'dark' ? theme.colors.dark[6] : '#fff';

  return {
    card: {
      height: '300px',
      background: theme.fn.gradient({ from: base[9], to: background, deg: 180 }),
    },

    content: {
      ref: getRef('content'),

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

const aDayAgo = dayjs().subtract(1, 'day').toDate();

export function AmbientModelCard({ data, width: itemWidth }: Props) {
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();
  const theme = useMantineTheme();
  const { push } = useRouter();

  const { id, image, name, rank, nsfw, user } = data ?? {};

  const [loading, setLoading] = useState(false);
  const { ref, inView } = useInView();
  const { openContext } = useRoutedContext();

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

  const height = useMemo(() => {
    if (!image.width || !image.height) return 300;
    const width = itemWidth > 0 ? itemWidth : 300;
    const aspectRatio = image.width / image.height;
    const imageHeight = Math.floor(width / aspectRatio);
    return Math.min(imageHeight, 600);
  }, [itemWidth, image.width, image.height]);

  const modelText = (
    <Text size={14} weight={500} color="white" style={{ flex: 1 }}>
      {name}
    </Text>
  );

  const modelBadges = (
    <>
      <Badge className={cx(classes.floatingBadge, classes.typeBadge)} radius="sm" size="sm">
        {splitUppercase(data.type)}
      </Badge>
      {data.status !== ModelStatus.Published && (
        <Badge className={cx(classes.floatingBadge, classes.statusBadge)} radius="sm" size="sm">
          {data.status}
        </Badge>
      )}
    </>
  );

  const modelRating = (
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
      // variant={theme.colorScheme === 'dark' && rank.ratingCount > 0 ? 'filled' : 'light'}
    >
      <Text size="xs" color={rank.ratingCount > 0 ? undefined : 'dimmed'}>
        {abbreviateNumber(rank.ratingCount)}
      </Text>
    </IconBadge>
  );

  const modelDownloads = (
    <IconBadge
      className={classes.statBadge}
      icon={<IconDownload size={14} />}
      // variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
    >
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
      // variant={theme.colorScheme === 'dark' && !isFavorite ? 'filled' : 'light'}
    >
      <Text size="xs">{abbreviateNumber(rank.favoriteCount)}</Text>
    </IconBadge>
  );

  const modelComments = !!rank.commentCount && (
    <IconBadge
      className={classes.statBadge}
      icon={<IconMessageCircle2 size={14} />}
      // variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
    >
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
          openContext('report', { type: ReportEntity.Model, entityId: id });
        }}
      >
        Report
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
        openContext('blockTags', { modelId: id });
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
    ]);
  if (currentUser) contextMenuItems.splice(2, 0, blockTagsOption);

  const isNew = data.createdAt > aDayAgo;
  const isUpdated = !isNew && data.lastVersionAt && data.lastVersionAt > aDayAgo;

  return (
    <Indicator
      disabled={!isNew && !isUpdated}
      withBorder
      size={24}
      radius="sm"
      label={isNew ? 'New' : 'Updated'}
      color="red"
      styles={{ indicator: { zIndex: 10, transform: 'translate(5px,-5px) !important' } }}
      sx={{ opacity: isHidden ? 0.1 : undefined }}
    >
      <Link href={`/models/${id}/${slugit(name)}`} passHref>
        <Card
          ref={ref}
          withBorder
          component="a"
          shadow="sm"
          className={classes.card}
          style={{ height: `${height}px` }}
          p={0}
          onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
            if (!(e.ctrlKey || e.metaKey) && e.button !== 1) setLoading(true);
          }}
        >
          {inView && (
            <>
              <LoadingOverlay visible={loading} zIndex={9} loaderProps={{ variant: 'dots' }} />
              <ImageGuard
                images={[image]}
                connect={{ entityId: id, entityType: 'model' }}
                nsfw={nsfw ?? image.nsfw} // if the image is nsfw, then most/all of the model is nsfw
                render={(image) => (
                  <Box sx={{ position: 'relative' }}>
                    {contextMenuItems.length > 0 && (
                      <Menu>
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
                      <ImageGuard.ToggleConnect
                        sx={(theme) => ({
                          backgroundColor: theme.fn.rgba(theme.colors.red[9], 0.4),
                          color: 'white',
                          backdropFilter: 'blur(7px)',
                          boxShadow: '1px 2px 3px -1px rgba(37,38,43,0.2)',
                        })}
                        position="static"
                      />
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
                {data.user.image && (
                  <Tooltip
                    position="left"
                    label={
                      <Text size="xs" weight={500}>
                        {data.user.username}
                      </Text>
                    }
                    offset={5}
                    radius="lg"
                    transition="slide-left"
                    transitionDuration={500}
                    openDelay={100}
                    closeDelay={250}
                    styles={{
                      tooltip: {
                        maxWidth: 200,
                        backgroundColor: 'rgba(0,0,0,.5)',
                        padding: '1px 10px 2px',
                        zIndex: 9,
                      },
                    }}
                    multiline
                  >
                    <Box
                      mx="xs"
                      sx={{
                        alignSelf: 'flex-end',
                        zIndex: 10,
                        borderRadius: '50%',
                      }}
                      onClick={(e: any) => {
                        e.preventDefault();
                        e.stopPropagation();
                        push(`/user/${data.user.username}`);
                      }}
                    >
                      <UserAvatar
                        size="md"
                        user={data.user}
                        avatarProps={{ className: classes.userAvatar }}
                      />
                    </Box>
                  </Tooltip>
                )}

                <Stack className={classes.content} spacing={6} p="xs">
                  <Group position="left" spacing={4}>
                    {modelText}
                  </Group>
                  <Group position="apart" spacing={0}>
                    {modelRating}
                    <Group spacing={4} align="center" ml="auto">
                      {modelLikes}
                      {modelComments}
                      {modelDownloads}
                    </Group>
                  </Group>
                </Stack>
              </Stack>
            </>
          )}
        </Card>
      </Link>
    </Indicator>
  );
}

type Props = {
  index: number;
  data: GetModelsInfiniteReturnType[number];
  width: number;
};
