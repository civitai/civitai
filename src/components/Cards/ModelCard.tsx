import {
  ActionIcon,
  Badge,
  Group,
  Indicator,
  Menu,
  Rating,
  Stack,
  Text,
  UnstyledButton,
  createStyles,
} from '@mantine/core';
import {
  IconStar,
  IconDownload,
  IconHeart,
  IconMessageCircle2,
  IconFlag,
  IconTagOff,
  IconPlaylistAdd,
  IconDotsVertical,
} from '@tabler/icons-react';
import image from 'next/image';
import { useRouter } from 'next/router';
import React from 'react';
import { useEffect } from 'react';
import { InView } from 'react-intersection-observer';
import { z } from 'zod';
import { FeedCard } from '~/components/Cards/FeedCard';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { HideModelButton } from '~/components/HideModelButton/HideModelButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { ReportEntity } from '~/server/schema/report.schema';
import { ModelGetAll } from '~/types/router';
import { aDayAgo } from '~/utils/date-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getDisplayName, slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const useStyles = createStyles((theme, _params, getRef) => {
  const imageRef = getRef('image');

  return {
    root: {
      position: 'relative',
      overflow: 'hidden',
      color: 'white',
      '&:hover': {
        [`& .${imageRef}`]: {
          transform: 'scale(1.05)',
        },
      },
    },

    image: {
      ref: imageRef,
      height: '100%',
      objectFit: 'cover',
      transition: 'transform 400ms ease',
    },

    gradientOverlay: {
      background: 'linear-gradient(transparent, rgba(0,0,0,.6))',
    },

    contentOverlay: {
      position: 'absolute',
      width: '100%',
      left: 0,
      zIndex: 10,
      padding: theme.spacing.sm,
    },

    top: { top: 0 },
    bottom: { bottom: 0 },

    iconBadge: { color: 'white' },
  };
});

const IMAGE_CARD_WIDTH = 450;
// To validate url query string
const querySchema = z.object({
  modelId: z.coerce.number().optional(),
  hidden: z.coerce.boolean().optional(),
});

export function ModelCard({ data }: Props) {
  const { classes, cx, theme } = useStyles();
  const router = useRouter();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const queryResult = querySchema.safeParse(router.query);
  const hiddenQuery = queryResult.success ? queryResult.data.hidden : false;
  const modelId = queryResult.success ? queryResult.data.modelId : undefined;

  const {
    data: { Favorite: favoriteModels = [], Hide: hiddenModels = [] } = { Favorite: [], Hide: [] },
  } = trpc.user.getEngagedModels.useQuery(undefined, {
    enabled: !!currentUser,
    cacheTime: Infinity,
    staleTime: Infinity,
  });
  const isFavorite = favoriteModels.find((modelId) => modelId === data.id);
  const { data: hiddenUsers = [] } = trpc.user.getHiddenUsers.useQuery(undefined, {
    enabled: !!currentUser,
    cacheTime: Infinity,
    staleTime: Infinity,
  });
  const isHidden =
    hidden.find(({ id }) => id === data.user.id) ||
    hiddenModels.find((modelId) => modelId === data.id);

  const reportOption = (
    <LoginRedirect reason="report-model" key="report">
      <Menu.Item
        icon={<IconFlag size={14} stroke={1.5} />}
        onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
          e.preventDefault();
          e.stopPropagation();
          openContext('report', { entityType: ReportEntity.Model, entityId: data.id });
        }}
      >
        Report Resource
      </Menu.Item>
    </LoginRedirect>
  );

  const reportImageOption = data.image && (
    <LoginRedirect reason="report-content" key="report-image">
      <Menu.Item
        icon={<IconFlag size={14} stroke={1.5} />}
        onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
          e.preventDefault();
          e.stopPropagation();
          openContext('report', {
            entityType: ReportEntity.Image,
            // Explicitly cast to number cause we know it's not undefined
            entityId: data.image?.id as number,
          });
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
        openContext('blockModelTags', { modelId: data.id });
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

  if (currentUser?.id !== data.user.id)
    contextMenuItems = contextMenuItems.concat([
      <HideModelButton key="hide-model" as="menu-item" modelId={data.id} />,
      <HideUserButton key="hide-button" as="menu-item" userId={data.user.id} />,
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
      <FeedCard href={`/models/${data.id}/${slugit(data.name)}`}>
        <div className={classes.root}>
          {data.image && (
            <ImageGuard
              images={[data.image]}
              connect={{ entityId: data.id, entityType: 'model' }}
              render={(image) => (
                <ImageGuard.Content>
                  {({ safe }) => {
                    // Small hack to prevent blurry landscape images
                    const originalAspectRatio =
                      image.width && image.height ? image.width / image.height : 1;

                    return (
                      <>
                        <Group
                          spacing={4}
                          position="apart"
                          className={cx(classes.contentOverlay, classes.top)}
                          noWrap
                        >
                          <Group spacing={4}>
                            <ImageGuard.ToggleConnect position="static" />
                            <Badge variant="light" color="dark">
                              <Text color="white" size="xs" transform="capitalize" inline>
                                {getDisplayName(data.type)}
                              </Text>
                            </Badge>
                          </Group>

                          {contextMenuItems.length > 0 && (
                            <Menu position="left-start" withArrow offset={-5}>
                              <Menu.Target>
                                <ActionIcon
                                  variant="transparent"
                                  p={0}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                  }}
                                >
                                  <IconDotsVertical
                                    size={24}
                                    color="#fff"
                                    style={{ filter: `drop-shadow(0 0 2px #000)` }}
                                  />
                                </ActionIcon>
                              </Menu.Target>
                              <Menu.Dropdown>{contextMenuItems.map((el) => el)}</Menu.Dropdown>
                            </Menu>
                          )}
                        </Group>
                        {safe ? (
                          <EdgeImage
                            src={image.url}
                            name={image.name ?? image.id.toString()}
                            alt={image.name ?? undefined}
                            width={
                              originalAspectRatio > 1
                                ? IMAGE_CARD_WIDTH * originalAspectRatio
                                : IMAGE_CARD_WIDTH
                            }
                            placeholder="empty"
                            className={classes.image}
                            loading="lazy"
                          />
                        ) : (
                          <MediaHash {...data.image} />
                        )}
                      </>
                    );
                  }}
                </ImageGuard.Content>
              )}
            />
          )}
          <Stack
            className={cx(classes.contentOverlay, classes.bottom, classes.gradientOverlay)}
            spacing="sm"
          >
            {data.user.id !== -1 && (
              <UnstyledButton
                sx={{ color: 'white' }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();

                  router.push(`/users/${data.user.username}`);
                }}
              >
                <UserAvatar
                  user={data.user}
                  avatarProps={{ radius: 'md', size: 32 }}
                  withUsername
                />
              </UnstyledButton>
            )}
            <Text size="xl" weight={700} lineClamp={2} inline>
              {data.name}
            </Text>
            <Group spacing={4} position="apart">
              {!data.locked && (
                <IconBadge
                  className={classes.iconBadge}
                  sx={{ userSelect: 'none' }}
                  color="dark"
                  icon={
                    <Rating
                      size="xs"
                      value={data.rank.rating}
                      fractions={4}
                      emptySymbol={
                        theme.colorScheme === 'dark' ? (
                          <IconStar size={14} fill="rgba(255,255,255,.3)" color="transparent" />
                        ) : undefined
                      }
                      readOnly
                    />
                  }
                >
                  <Text size="xs" color={data.rank.ratingCount > 0 ? undefined : 'dimmed'}>
                    {abbreviateNumber(data.rank.ratingCount)}
                  </Text>
                </IconBadge>
              )}
              <Group spacing={4} noWrap>
                <IconBadge
                  className={classes.iconBadge}
                  color="dark"
                  icon={
                    <IconHeart
                      size={14}
                      style={{ fill: isFavorite ? theme.colors.red[6] : undefined }}
                      color={isFavorite ? theme.colors.red[6] : undefined}
                    />
                  }
                >
                  <Text size="xs">{abbreviateNumber(data.rank.favoriteCount)}</Text>
                </IconBadge>
                <IconBadge
                  className={classes.iconBadge}
                  color="dark"
                  icon={<IconMessageCircle2 size={14} />}
                >
                  <Text size="xs">{abbreviateNumber(data.rank.commentCount)}</Text>
                </IconBadge>
                <IconBadge
                  className={classes.iconBadge}
                  color="dark"
                  icon={<IconDownload size={14} />}
                >
                  <Text size="xs">{abbreviateNumber(data.rank.downloadCount)}</Text>
                </IconBadge>
              </Group>
            </Group>
          </Stack>
        </div>
      </FeedCard>
    </Indicator>
  );
}

type Props = { data: ModelGetAll['items'][number] };
