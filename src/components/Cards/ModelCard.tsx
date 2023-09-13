import {
  ActionIcon,
  Badge,
  Divider,
  Group,
  Menu,
  Rating,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import {
  IconStar,
  IconDownload,
  IconHeart,
  IconMessageCircle2,
  IconTagOff,
  IconDotsVertical,
  IconBrush,
  IconPlaylistAdd,
  IconInfoCircle,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React from 'react';
import { useEffect } from 'react';
import { z } from 'zod';
import { FeedCard } from '~/components/Cards/FeedCard';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { HideModelButton } from '~/components/HideModelButton/HideModelButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { AddToCollectionMenuItem } from '~/components/MenuItems/AddToCollectionMenuItem';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { BaseModel, baseModelSets, constants } from '~/server/common/constants';
import { ReportEntity } from '~/server/schema/report.schema';
import { aDayAgo } from '~/utils/date-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getDisplayName, slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { CollectionType } from '@prisma/client';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { CivitiaLinkManageButton } from '~/components/CivitaiLink/CivitiaLinkManageButton';
import { generationPanel } from '~/store/generation.store';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { InView } from 'react-intersection-observer';
import { UseQueryModelReturn } from '~/components/Model/model.utils';
import { AddToCollectionDropdown } from '~/components/Collections/AddToCollectionDropdown';
import { StarRating } from '../StartRating/StarRating';
import { env } from '~/env/client.mjs';

const IMAGE_CARD_WIDTH = 450;
// To validate url query string
const querySchema = z.object({
  model: z.coerce.number().optional(),
  hidden: z.coerce.boolean().optional(),
});

export function ModelCard({ data }: Props) {
  const { classes, cx, theme } = useCardStyles({
    aspectRatio:
      data.image && data.image.width && data.image.height
        ? data.image.width / data.image.height
        : 1,
  });

  const router = useRouter();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const queryResult = querySchema.safeParse(router.query);
  const hiddenQuery = queryResult.success ? queryResult.data.hidden : false;
  const modelId = queryResult.success ? queryResult.data.model : undefined;

  const { data: { Favorite: favoriteModels = [] } = { Favorite: [] } } =
    trpc.user.getEngagedModels.useQuery(undefined, {
      enabled: !!currentUser,
      cacheTime: Infinity,
      staleTime: Infinity,
    });
  const isFavorite = favoriteModels.find((modelId) => modelId === data.id);

  // const { users: hiddenUsers, models: hiddenModels } = useHiddenPreferencesContext();
  // const isHidden = hiddenUsers.get(data.user.id) || hiddenModels.get(data.id);

  const reportOption = (
    <ReportMenuItem
      key="report-model"
      loginReason="report-model"
      onReport={() => openContext('report', { entityType: ReportEntity.Model, entityId: data.id })}
    />
  );

  const reportImageOption = data.image && (
    <ReportMenuItem
      key="report-image"
      label="Report image"
      onReport={() =>
        openContext('report', {
          entityType: ReportEntity.Image,
          // Explicitly cast to number because we know it's not undefined
          entityId: data.image?.id as number,
        })
      }
    />
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
      <AddToCollectionMenuItem
        key="add-to-collection"
        onClick={() =>
          openContext('addToCollection', { modelId: data.id, type: CollectionType.Model })
        }
      />,
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

  if (currentUser?.isModerator && env.NEXT_PUBLIC_MODEL_LOOKUP_URL) {
    contextMenuItems.unshift(
      <Menu.Item
        component="a"
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
  const isSDXL = baseModelSets.SDXL.includes(data.version?.baseModel as BaseModel);

  useEffect(() => {
    if (!modelId || modelId !== data.id) return;
    const elem = document.getElementById(`${modelId}`);
    if (elem) {
      elem.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
    }
  }, [modelId, data.id]);

  return (
    <FeedCard
      className={!data.image ? classes.noImage : undefined}
      href={`/models/${data.id}/${slugit(data.name)}`}
      // sx={{ opacity: isHidden ? 0.1 : undefined }}
    >
      <InView rootMargin="600px">
        {({ ref, inView }) => (
          <div className={classes.root} ref={ref}>
            {inView && (
              <>
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
                                align="start"
                                className={cx(classes.contentOverlay, classes.top)}
                                noWrap
                              >
                                <Group spacing={4}>
                                  <ImageGuard.ToggleConnect
                                    className={classes.chip}
                                    position="static"
                                  />
                                  <Badge
                                    className={cx(classes.infoChip, classes.chip)}
                                    variant="light"
                                    radius="xl"
                                  >
                                    <Text color="white" size="xs" transform="capitalize">
                                      {getDisplayName(data.type)}
                                    </Text>
                                    {isSDXL && (
                                      <>
                                        <Divider orientation="vertical" />
                                        <Text color="white" size="xs">
                                          XL
                                        </Text>
                                      </>
                                    )}
                                  </Badge>

                                  {(isNew || isUpdated) && (
                                    <Badge
                                      className={classes.chip}
                                      variant="filled"
                                      radius="xl"
                                      sx={(theme) => ({
                                        backgroundColor: isUpdated
                                          ? '#1EBD8E'
                                          : theme.colors.blue[theme.fn.primaryShade()],
                                      })}
                                    >
                                      <Text color="white" size="xs" transform="capitalize">
                                        {isUpdated ? 'Updated' : 'New'}
                                      </Text>
                                    </Badge>
                                  )}
                                </Group>
                                <Stack spacing="xs">
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
                                      <Menu.Dropdown>
                                        {contextMenuItems.map((el) => el)}
                                      </Menu.Dropdown>
                                    </Menu>
                                  )}
                                  {features.imageGeneration &&
                                    data.canGenerate &&
                                    data.version?.id && (
                                      <HoverActionButton
                                        label="Create"
                                        size={30}
                                        color="white"
                                        variant="filled"
                                        onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          generationPanel.open({
                                            type: 'model',
                                            id: data.version.id,
                                          });
                                        }}
                                      >
                                        <IconBrush stroke={2.5} size={16} />
                                      </HoverActionButton>
                                    )}
                                  <CivitiaLinkManageButton
                                    modelId={data.id}
                                    modelName={data.name}
                                    modelType={data.type}
                                    hashes={data.hashes}
                                    noTooltip
                                    iconSize={16}
                                  >
                                    {({ color, onClick, icon, label }) => (
                                      <HoverActionButton
                                        onClick={onClick}
                                        label={label}
                                        size={30}
                                        color={color}
                                        variant="filled"
                                        keepIconOnHover
                                      >
                                        {icon}
                                      </HoverActionButton>
                                    )}
                                  </CivitiaLinkManageButton>
                                </Stack>
                              </Group>
                              {image ? (
                                <>
                                  {safe ? (
                                    <EdgeMedia
                                      src={image.url}
                                      name={image.name ?? image.id.toString()}
                                      alt={image.name ?? undefined}
                                      type={image.type}
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
                              ) : (
                                <>
                                  <Text color="dimmed">This model has no images</Text>
                                </>
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
                  spacing="xs"
                >
                  {data.user.id !== -1 && (
                    <UnstyledButton
                      sx={{ color: 'white', alignSelf: 'flex-start' }}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();

                        router.push(`/user/${data.user.username}`);
                      }}
                    >
                      <UserAvatar
                        user={data.user}
                        avatarProps={{ radius: 'md', size: 32 }}
                        withUsername
                      />
                    </UnstyledButton>
                  )}
                  <Text size="xl" weight={700} lineClamp={2} lh={1.3}>
                    {data.name}
                  </Text>
                  <Group spacing={4} position="apart">
                    {!data.locked && (
                      <IconBadge
                        className={classes.iconBadge}
                        sx={{ userSelect: 'none' }}
                        icon={<StarRating size={14} value={data.rank.rating} />}
                      >
                        <Text
                          size="xs"
                          color={data.rank.ratingCount > 0 ? undefined : 'dimmed'}
                          inline
                        >
                          {abbreviateNumber(data.rank.ratingCount)}
                        </Text>
                      </IconBadge>
                    )}
                    <Group spacing={4} noWrap>
                      <IconBadge
                        className={classes.iconBadge}
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
                        icon={<IconMessageCircle2 size={14} />}
                      >
                        <Text size="xs">{abbreviateNumber(data.rank.commentCount)}</Text>
                      </IconBadge>
                      <IconBadge className={classes.iconBadge} icon={<IconDownload size={14} />}>
                        <Text size="xs">{abbreviateNumber(data.rank.downloadCount)}</Text>
                      </IconBadge>
                      <AddToCollectionDropdown
                        dropdownTrigger={
                          <IconBadge
                            className={classes.iconBadge}
                            icon={<IconPlaylistAdd size={14} />}
                          >
                            <Text size="xs">{abbreviateNumber(data.rank.collectedCount)}</Text>
                          </IconBadge>
                        }
                        modelId={data.id}
                        type={CollectionType.Model}
                      />
                    </Group>
                  </Group>
                </Stack>
              </>
            )}
          </div>
        )}
      </InView>
    </FeedCard>
  );
}

type Props = { data: UseQueryModelReturn[number] };
