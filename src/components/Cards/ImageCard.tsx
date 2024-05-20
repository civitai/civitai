import { ActionIcon, Group, Stack, UnstyledButton } from '@mantine/core';
import { IconBrush, IconInfoCircle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { FeedCard } from '~/components/Cards/FeedCard';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { Reactions } from '~/components/Reaction/Reactions';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { DEFAULT_EDGE_IMAGE_WIDTH, constants } from '~/server/common/constants';
import HoverActionButton from './components/HoverActionButton';
import { generationPanel } from '~/store/generation.store';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { useImagesContext } from '~/components/Image/Providers/ImagesProvider';
import { OnsiteIndicator } from '~/components/Image/Indicators/OnsiteIndicator';
import { CosmeticType } from '@prisma/client';
import { HolidayFrame } from '../Decorations/HolidayFrame';
import { truncate } from 'lodash-es';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';

function UnroutedImageCard({ data }: Props) {
  const { classes: sharedClasses, cx } = useCardStyles({
    aspectRatio: data.width && data.height ? data.width / data.height : 1,
  });
  const router = useRouter();
  const features = useFeatureFlags();

  const cardDecoration = data.user.cosmetics?.find(
    ({ cosmetic }) => cosmetic.type === CosmeticType.ContentDecoration
  ) as (typeof data.user.cosmetics)[number] & {
    data?: { lights?: number; upgradedLights?: number };
  };

  const originalAspectRatio = data.width && data.height ? data.width / data.height : 1;
  const onSite = data.meta && 'civitaiResources' in data.meta;
  const imageWidth =
    originalAspectRatio > 1
      ? DEFAULT_EDGE_IMAGE_WIDTH * originalAspectRatio
      : DEFAULT_EDGE_IMAGE_WIDTH;

  return (
    <HolidayFrame {...cardDecoration}>
      <FeedCard className={sharedClasses.link} frameDecoration={data.cosmetic}>
        <div className={sharedClasses.root}>
          <ImageGuard2 image={data}>
            {(safe) => (
              <>
                {onSite && <OnsiteIndicator />}
                <Group
                  position="apart"
                  align="start"
                  spacing={4}
                  className="absolute inset-x-2 top-2 z-10"
                  style={{ pointerEvents: 'none' }}
                >
                  <ImageGuard2.BlurToggle radius="xl" h={26} sx={{ pointerEvents: 'auto' }} />
                  {safe && (
                    <Stack spacing="xs" ml="auto" style={{ pointerEvents: 'auto' }}>
                      <ImageContextMenu image={data} />
                      {features.imageGeneration && data.meta && (
                        <HoverActionButton
                          label="Remix"
                          size={30}
                          color="white"
                          variant="filled"
                          data-activity="remix:image-card"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            generationPanel.open({
                              type: 'image',
                              id: data.id,
                            });
                          }}
                        >
                          <IconBrush stroke={2.5} size={16} />
                        </HoverActionButton>
                      )}
                    </Stack>
                  )}
                </Group>
                {safe ? (
                  <div
                    className={data.cosmetic ? sharedClasses.frameAdjustment : undefined}
                    style={{ height: '100%' }}
                  >
                    <EdgeMedia
                      src={data.url}
                      name={data.name ?? data.id.toString()}
                      alt={
                        data.meta
                          ? truncate(data.meta.prompt, { length: constants.altTruncateLength })
                          : data.name ?? undefined
                      }
                      type={data.type}
                      width={imageWidth}
                      className={sharedClasses.image}
                      wrapperProps={{ style: { height: '100%', width: '100%' } }}
                      loading="lazy"
                      contain
                    />
                  </div>
                ) : (
                  <MediaHash {...data} />
                )}
              </>
            )}
          </ImageGuard2>

          <Stack
            className={cx('footer', sharedClasses.contentOverlay, sharedClasses.bottom)}
            spacing="sm"
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
                  // Explicit casting to comply with ts
                  user={data.user as ImagesInfiniteModel['user']}
                  avatarProps={{ radius: 'xl', size: 32 }}
                  withUsername
                />
              </UnstyledButton>
            )}
            <Group spacing={4} position="apart">
              <Reactions
                className={sharedClasses.reactions}
                entityId={data.id}
                entityType="image"
                reactions={data.reactions}
                metrics={{
                  likeCount: data.stats?.likeCountAllTime,
                  dislikeCount: data.stats?.dislikeCountAllTime,
                  heartCount: data.stats?.heartCountAllTime,
                  laughCount: data.stats?.laughCountAllTime,
                  cryCount: data.stats?.cryCountAllTime,
                  tippedAmountCount: data.stats?.tippedAmountCountAllTime,
                }}
                targetUserId={data.user.id}
              />
              {data.hasMeta && data.meta && (
                <ImageMetaPopover meta={data.meta}>
                  <ActionIcon className={sharedClasses.infoChip} variant="light">
                    <IconInfoCircle color="white" strokeWidth={2.5} size={18} />
                  </ActionIcon>
                </ImageMetaPopover>
              )}
            </Group>
          </Stack>
        </div>
      </FeedCard>
    </HolidayFrame>
  );
}
export function ImageCard({ data }: Props) {
  const context = useImagesContext();

  return (
    <RoutedDialogLink name="imageDetail" state={{ imageId: data.id, ...context }}>
      <UnroutedImageCard data={data} />
    </RoutedDialogLink>
  );
}

type Props = { data: ImagesInfiniteModel };
