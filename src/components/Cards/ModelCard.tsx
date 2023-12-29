import {
  ActionIcon,
  Badge,
  Divider,
  Group,
  Menu,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconDownload,
  IconHeart,
  IconMessageCircle2,
  IconTagOff,
  IconDotsVertical,
  IconBrush,
  IconPlaylistAdd,
  IconInfoCircle,
  IconBolt,
  IconClubs,
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
import { CollectionType, CosmeticType } from '@prisma/client';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { CivitiaLinkManageButton } from '~/components/CivitaiLink/CivitiaLinkManageButton';
import { generationPanel } from '~/store/generation.store';
import { UseQueryModelReturn } from '~/components/Model/model.utils';
import { AddToCollectionDropdown } from '~/components/Collections/AddToCollectionDropdown';
import { StarRating } from '../StartRating/StarRating';
import { env } from '~/env/client.mjs';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';
import { useModelCardContext } from '~/components/Cards/ModelCardContext';
import { AddToShowcaseMenuItem } from '~/components/Profile/AddToShowcaseMenuItem';
import { OnsiteIndicator } from '~/components/Image/Indicators/OnsiteIndicator';
import { useInView } from '~/hooks/useInView';
import { HolidayFrame } from '../Decorations/HolidayFrame';
import { ClubPostFromResourceMenuItem } from '../Club/ClubPostFromResourceMenuItem';
import { AddToClubMenuItem } from '../Club/AddToClubMenuItem';

const IMAGE_CARD_WIDTH = 450;
// To validate url query string
const querySchema = z.object({
  model: z.coerce.number().optional(),
  hidden: z.coerce.boolean().optional(),
});

export function ModelCard({ data, forceInView }: Props) {
  const { ref, inView } = useInView({
    rootMargin: '200% 0px',
    skip: forceInView,
    initialInView: forceInView,
  });
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
  const tippedAmount = useBuzzTippingStore({ entityType: 'Model', entityId: data.id });

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

  if (features.clubs) {
    contextMenuItems = contextMenuItems.concat([
      <ClubPostFromResourceMenuItem
        key="create-club-post-from-resource"
        entityType="Model"
        entityId={data.id}
      />,
    ]);
  }

  if (features.profileOverhaul && currentUser?.id === data.user.id) {
    contextMenuItems = contextMenuItems.concat([
      <AddToShowcaseMenuItem key="add-to-showcase" entityType="Model" entityId={data.id} />,
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
  const onSite = !!data.version.trainingStatus;

  const { useModelVersionRedirect } = useModelCardContext();
  let href = `/models/${data.id}/${slugit(data.name)}`;
  if (useModelVersionRedirect) href += `?modelVersionId=${data.version.id}`;

  const cardDecoration = data.user.cosmetics?.find(
    ({ cosmetic }) => cosmetic.type === CosmeticType.ContentDecoration
  ) as (typeof data.user.cosmetics)[number] & {
    data?: { lights?: number; upgradedLights?: number };
  };

  return (
    <HolidayFrame {...cardDecoration}>
      <FeedCard className={!data.image ? classes.noImage : undefined} href={href}>
        <div className={classes.root} ref={ref}>
          {data.image && (
            <div className={classes.blurHash}>
              <MediaHash {...data.image} />
            </div>
          )}
          <div className={classes.content} style={{ opacity: inView ? 1 : undefined }}>
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
                                    <Menu position="left-start" withArrow offset={-5} withinPortal>
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
                                  {data.requiresClub && (
                                    <Tooltip
                                      label="This model requires joining a club to get access to it."
                                      withinPortal
                                      maw={350}
                                    >
                                      <ThemeIcon size={30} radius="xl" color="blue">
                                        <IconClubs stroke={2.5} size={16} />
                                      </ThemeIcon>
                                    </Tooltip>
                                  )}
                                  {features.imageGeneration && data.canGenerate && (
                                    <HoverActionButton
                                      label="Create"
                                      size={30}
                                      color="white"
                                      variant="filled"
                                      onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        generationPanel.open({
                                          type: 'modelVersion',
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
                                  {safe && (
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
                                      // loading="lazy"
                                      wrapperProps={{ style: { height: '100%', width: '100%' } }}
                                      contain
                                    />
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
                  className={cx(
                    'footer',
                    classes.contentOverlay,
                    classes.bottom,
                    classes.gradientOverlay
                  )}
                  spacing={5}
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
                        badgeSize={28}
                      />
                    </UnstyledButton>
                  )}
                  <Text size="xl" weight={700} lineClamp={2} lh={1.3}>
                    {data.name}
                  </Text>
                  {data.rank && (
                    <>
                      {!data.locked && !!data.rank.ratingCount && (
                        <Badge
                          className={cx(classes.statChip, classes.chip)}
                          variant="light"
                          radius="xl"
                        >
                          <Group spacing={4}>
                            <StarRating size={14} value={data.rank.rating} />
                            <Text size="xs">{data.rank.ratingCount}</Text>
                          </Group>
                        </Badge>
                      )}
                      {(!!data.rank.favoriteCount ||
                        !!data.rank.downloadCount ||
                        !!data.rank.collectedCount ||
                        !!data.rank.tippedAmountCount) && (
                        <Badge
                          className={cx(classes.statChip, classes.chip)}
                          variant="light"
                          radius="xl"
                        >
                          <Group spacing={2}>
                            <IconDownload size={14} strokeWidth={2.5} />
                            <Text size="xs">{abbreviateNumber(data.rank.downloadCount)}</Text>
                          </Group>
                          <Group spacing={2}>
                            <IconHeart
                              size={14}
                              strokeWidth={2.5}
                              style={{ fill: isFavorite ? theme.colors.red[6] : undefined }}
                              color={isFavorite ? theme.colors.red[6] : undefined}
                            />
                            <Text size="xs">{abbreviateNumber(data.rank.favoriteCount)}</Text>
                          </Group>
                          <Group spacing={2}>
                            <IconPlaylistAdd size={14} strokeWidth={2.5} />
                            <Text size="xs">{abbreviateNumber(data.rank.collectedCount)}</Text>
                          </Group>
                          <Group spacing={2}>
                            <IconMessageCircle2 size={14} strokeWidth={2.5} />
                            <Text size="xs">{abbreviateNumber(data.rank.commentCount)}</Text>
                          </Group>
                          <InteractiveTipBuzzButton
                            toUserId={data.user.id}
                            entityType={'Model'}
                            entityId={data.id}
                          >
                            <Group spacing={2}>
                              <IconBolt size={14} strokeWidth={2.5} />
                              <Text size="xs">
                                {abbreviateNumber(data.rank.tippedAmountCount + tippedAmount)}
                              </Text>
                            </Group>
                          </InteractiveTipBuzzButton>
                        </Badge>
                      )}
                    </>
                  )}
                  {/* {data.rank && (
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
                      <Group spacing={4}>
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
                        <InteractiveTipBuzzButton
                          toUserId={data.user.id}
                          entityType={'Model'}
                          entityId={data.id}
                        >
                          <IconBadge className={classes.iconBadge} icon={<IconBolt size={14} />}>
                            <Text size="xs">
                              {abbreviateNumber(data.rank.tippedAmountCount + tippedAmount)}
                            </Text>
                          </IconBadge>
                        </InteractiveTipBuzzButton>
                      </Group>
                    </Group>
                  )} */}
                </Stack>
                {onSite && <OnsiteIndicator />}
              </>
            )}
          </div>
        </div>
      </FeedCard>
    </HolidayFrame>
  );
}

type Props = { data: UseQueryModelReturn[number]; forceInView?: boolean };
