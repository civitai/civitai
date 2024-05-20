import { ActionIcon, Badge, Center, Divider, Group, Menu, Stack, Text } from '@mantine/core';
import {
  IconDownload,
  IconMessageCircle2,
  IconTagOff,
  IconDotsVertical,
  IconBrush,
  IconBookmark,
  IconInfoCircle,
  IconBolt,
  IconArchiveFilled,
  IconHorse,
} from '@tabler/icons-react';
import React from 'react';
// import { z } from 'zod';
import { FeedCard } from '~/components/Cards/FeedCard';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { HideModelButton } from '~/components/HideModelButton/HideModelButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { AddToCollectionMenuItem } from '~/components/MenuItems/AddToCollectionMenuItem';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { BaseModel, baseModelSets, constants } from '~/server/common/constants';
import { ReportEntity } from '~/server/schema/report.schema';
import { aDayAgo } from '~/utils/date-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { getDisplayName, slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { CollectionType, CosmeticEntity, ModelModifier } from '@prisma/client';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { CivitaiLinkManageButton } from '~/components/CivitaiLink/CivitaiLinkManageButton';
import { generationPanel } from '~/store/generation.store';
import { UseQueryModelReturn } from '~/components/Model/model.utils';
import { env } from '~/env/client.mjs';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';
import { useModelCardContext } from '~/components/Cards/ModelCardContext';
import { AddToShowcaseMenuItem } from '~/components/Profile/AddToShowcaseMenuItem';
import { OnsiteIndicator } from '~/components/Image/Indicators/OnsiteIndicator';
import { useInView } from '~/hooks/useInView';
import { truncate } from 'lodash-es';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { ToggleSearchableMenuItem } from '../MenuItems/ToggleSearchableMenuItem';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { AddArtFrameMenuItem } from '~/components/Decorations/AddArtFrameMenuItem';
import { IconNose } from '~/components/SVG/IconNose';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';

const IMAGE_CARD_WIDTH = 450;

export function ModelCard({ data, forceInView }: Props) {
  const { ref, inView } = useInView({
    rootMargin: '200% 0px',
    skip: forceInView,
    initialInView: forceInView,
  });
  const image = data.images[0];
  const aspectRatio = image && image.width && image.height ? image.width / image.height : 1;
  const { classes, cx } = useCardStyles({
    aspectRatio,
  });

  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const tippedAmount = useBuzzTippingStore({ entityType: 'Model', entityId: data.id });

  const { data: { Recommended: reviewedModels = [] } = { Recommended: [] } } =
    trpc.user.getEngagedModels.useQuery(undefined, {
      enabled: !!currentUser,
      cacheTime: Infinity,
      staleTime: Infinity,
    });
  const hasReview = reviewedModels.includes(data.id);

  const reportOption = (
    <ReportMenuItem
      key="report-model"
      loginReason="report-model"
      onReport={() => openContext('report', { entityType: ReportEntity.Model, entityId: data.id })}
    />
  );

  const reportImageOption = image && (
    <ReportMenuItem
      key="report-image"
      label="Report image"
      onReport={() =>
        openContext('report', {
          entityType: ReportEntity.Image,
          entityId: image.id,
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

  if (features.profileOverhaul && currentUser?.id === data.user.id) {
    contextMenuItems = contextMenuItems.concat([
      <AddToShowcaseMenuItem key="add-to-showcase" entityType="Model" entityId={data.id} />,
      <AddArtFrameMenuItem
        key="add-art-frame"
        entityType={CosmeticEntity.Model}
        entityId={data.id}
        image={data.images[0]}
        currentCosmetic={data.cosmetic}
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
  const isSDXL = [...baseModelSets.SDXL, ...baseModelSets.Pony].includes(
    data.version?.baseModel as BaseModel
  );
  const isPony = data.version?.baseModel === 'Pony';
  const isOdor = data.version?.baseModel === 'ODOR';
  const isArchived = data.mode === ModelModifier.Archived;
  const onSite = !!data.version.trainingStatus;

  const thumbsUpCount = data.rank?.thumbsUpCount ?? 0;
  const thumbsDownCount = data.rank?.thumbsDownCount ?? 0;
  const totalCount = thumbsUpCount + thumbsDownCount;
  const positiveRating = totalCount > 0 ? thumbsUpCount / totalCount : 0;

  const { useModelVersionRedirect } = useModelCardContext();
  let href = `/models/${data.id}/${slugit(data.name)}`;
  if (useModelVersionRedirect) href += `?modelVersionId=${data.version.id}`;

  // Small hack to prevent blurry landscape images
  const originalAspectRatio = image && image.width && image.height ? image.width / image.height : 1;

  return (
    <FeedCard
      className={!image ? classes.noImage : undefined}
      href={href}
      frameDecoration={data.cosmetic}
    >
      <div className={classes.root} ref={ref}>
        <div className={classes.content} style={{ opacity: inView ? 1 : undefined }}>
          {inView && (
            <>
              {image ? (
                <ImageGuard2 image={image} connectType="model" connectId={data.id}>
                  {(safe) => (
                    <>
                      <Group
                        spacing={4}
                        position="apart"
                        align="start"
                        className={cx(classes.contentOverlay, classes.top)}
                        noWrap
                      >
                        <Group spacing={4}>
                          <ImageGuard2.BlurToggle className={classes.chip} />
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
                                {isPony ? (
                                  <IconHorse size={16} strokeWidth={2.5} />
                                ) : (
                                  <Text color="white" size="xs">
                                    XL
                                  </Text>
                                )}
                              </>
                            )}
                            {isOdor && (
                              <>
                                <Divider orientation="vertical" />
                                <IconNose size={16} strokeWidth={2} />
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
                                  ? theme.colors.success[5]
                                  : theme.colors.blue[theme.fn.primaryShade()],
                              })}
                            >
                              <Text color="white" size="xs" transform="capitalize">
                                {isUpdated ? 'Updated' : 'New'}
                              </Text>
                            </Badge>
                          )}
                          {isArchived && (
                            <Badge
                              className={cx(classes.infoChip, classes.chip)}
                              variant="light"
                              radius="xl"
                            >
                              <IconArchiveFilled size={16} />
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
                              <Menu.Dropdown>{contextMenuItems.map((el) => el)}</Menu.Dropdown>
                            </Menu>
                          )}

                          {features.imageGeneration && data.canGenerate && (
                            <HoverActionButton
                              label="Create"
                              size={30}
                              color="white"
                              variant="filled"
                              data-activity="create:model-card"
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
                          <CivitaiLinkManageButton
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
                          </CivitaiLinkManageButton>
                        </Stack>
                      </Group>
                      {safe ? (
                        <div
                          className={data.cosmetic ? classes.frameAdjustment : undefined}
                          style={{ height: '100%' }}
                        >
                          <EdgeMedia
                            src={image.url}
                            name={image.name ?? image.id.toString()}
                            alt={
                              image.meta
                                ? truncate((image.meta as ImageMetaProps).prompt, {
                                    length: 125,
                                  })
                                : undefined
                            }
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
                        </div>
                      ) : (
                        <div className={classes.blurHash}>
                          <MediaHash {...image} />
                        </div>
                      )}
                    </>
                  )}
                </ImageGuard2>
              ) : (
                <Center h="100%">
                  <Text color="dimmed">This model has no images</Text>
                </Center>
              )}

              <Stack className={cx('footer', classes.contentOverlay, classes.bottom)} spacing={5}>
                {data.user.id !== -1 && <UserAvatarSimple {...data.user} />}
                <Text className={classes.dropShadow} size="xl" weight={700} lineClamp={3} lh={1.2}>
                  {data.name}
                </Text>
                {data.rank && (
                  <Group align="center" position="apart" spacing={4}>
                    {(!!data.rank.downloadCount ||
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
                          <IconBookmark size={14} strokeWidth={2.5} />
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
                            <Text size="xs" tt="uppercase">
                              {abbreviateNumber(data.rank.tippedAmountCount + tippedAmount)}
                            </Text>
                          </Group>
                        </InteractiveTipBuzzButton>
                      </Badge>
                    )}
                    {!data.locked && !!data.rank.thumbsUpCount && (
                      <Badge
                        className={cx(classes.statChip, classes.chip)}
                        pl={6}
                        pr={8}
                        data-reviewed={hasReview}
                        radius="xl"
                        title={`${Math.round(positiveRating * 100)}% of reviews are positive`}
                      >
                        <Group spacing={4}>
                          <Text color={hasReview ? 'success.5' : 'yellow'} component="span" mt={2}>
                            <ThumbsUpIcon size={20} filled={hasReview} strokeWidth={2.5} />
                          </Text>
                          <Text size={16} weight={500}>
                            {abbreviateNumber(data.rank.thumbsUpCount)}
                          </Text>
                        </Group>
                      </Badge>
                    )}
                  </Group>
                )}
              </Stack>
              {onSite && <OnsiteIndicator />}
            </>
          )}
        </div>
      </div>
    </FeedCard>
  );
}

type Props = { data: UseQueryModelReturn[number]; forceInView?: boolean };
