import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  Stack,
  createStyles,
} from '@mantine/core';
import { IconBrush, IconInfoCircle } from '@tabler/icons-react';
import { Fragment, useRef, useState } from 'react';
import { AdUnitTop } from '~/components/Ads/AdUnit';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { shouldDisplayHtmlControls } from '~/components/EdgeMedia/EdgeMedia.util';
import { EdgeVideoRef } from '~/components/EdgeMedia/EdgeVideo';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { PostContestCollectionInfoAlert } from '~/components/Post/Detail/PostContestCollectionInfoAlert';
import { Reactions } from '~/components/Reaction/Reactions';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { MAX_POST_IMAGES_WIDTH } from '~/server/common/constants';
import { VideoMetadata } from '~/server/schema/media.schema';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';
import { generationPanel } from '~/store/generation.store';
import { PostContestCollectionItem } from '~/types/router';

const maxWidth = MAX_POST_IMAGES_WIDTH;
const maxInitialImages = 20;
export function PostImages({
  postId,
  images,
  isLoading,
  collectionItems,
  isOwner,
  isModerator,
}: {
  postId: number;
  images: ImagesInfiniteModel[];
  isLoading?: boolean;
  collectionItems?: PostContestCollectionItem[];
  isOwner?: boolean;
  isModerator?: boolean;
}) {
  const { classes, cx } = useStyles();
  const [showMore, setShowMore] = useState(false);
  const videoRef = useRef<EdgeVideoRef | null>(null);
  const features = useFeatureFlags();

  if (isLoading)
    return (
      <Paper component={Center} p="xl" mih={300} withBorder>
        <Group>
          <Loader />
          Loading Images
        </Group>
      </Paper>
    );

  const remainingImages = images.length - maxInitialImages;
  const _images = showMore ? images : images.slice(0, maxInitialImages);

  return (
    <Stack>
      {_images.map((image, i) => {
        const width = image.width ?? maxWidth;
        const imageCollectionItem = collectionItems?.find((item) => item.imageId === image.id);
        const showImageCollectionBadge =
          imageCollectionItem?.tag &&
          (isOwner || isModerator || imageCollectionItem.status === CollectionItemStatus.ACCEPTED);
        const vimeoVideoId = (image.metadata as VideoMetadata)?.vimeoVideoId;

        return (
          <Fragment key={image.id}>
            <PostContestCollectionInfoAlert
              isOwner={isOwner}
              collectionItem={imageCollectionItem}
              itemLabel="image"
              isModerator={isModerator}
            />
            <Paper
              key={image.id}
              radius="md"
              className="relative overflow-hidden"
              shadow="md"
              mx="auto"
              style={{
                maxWidth: '100%',
                width: width < maxWidth ? width : maxWidth,
                aspectRatio:
                  image.width && image.height ? `${image.width}/${image.height}` : undefined,
              }}
            >
              <ImageGuard2 image={image} connectType="post" connectId={postId}>
                {(safe) => (
                  <>
                    <Group spacing={4} className="absolute left-2 top-2 z-10">
                      <ImageGuard2.BlurToggle />
                      {showImageCollectionBadge && (
                        <Badge variant="filled" color="gray">
                          {imageCollectionItem?.tag?.name}
                        </Badge>
                      )}
                    </Group>
                    <div
                      className={cx('absolute right-2 top-2 z-10 flex flex-col gap-2', {
                        'right-10 top-2.5': !!vimeoVideoId,
                      })}
                    >
                      <ImageContextMenu image={image} />
                      {features.imageGeneration && (image.hasPositivePrompt ?? image.hasMeta) && (
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
                              type: image.type,
                              id: image.id,
                            });
                          }}
                        >
                          <IconBrush stroke={2.5} size={16} />
                        </HoverActionButton>
                      )}
                    </div>
                    <RoutedDialogLink
                      name="imageDetail"
                      state={{
                        imageId: image.id,
                        images,
                        collectionId: imageCollectionItem?.collection?.id,
                      }}
                      onClick={() => {
                        if (videoRef.current) videoRef.current.stop();
                      }}
                    >
                      {!safe ? (
                        <div
                          style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            aspectRatio: (image.width ?? 1) / (image.height ?? 1),
                          }}
                        >
                          <MediaHash {...image} />
                        </div>
                      ) : (
                        <EdgeMedia
                          src={image.url}
                          name={image.name}
                          alt={image.name ?? undefined}
                          type={image.type}
                          width={width < maxWidth ? width : maxWidth}
                          original={image.type === 'video'}
                          anim={safe}
                          html5Controls={shouldDisplayHtmlControls(image)}
                          videoRef={videoRef}
                          vimeoVideoId={vimeoVideoId}
                        />
                      )}
                    </RoutedDialogLink>
                    <Reactions
                      className={cx(classes.reactions, {
                        [classes.reactionsWithControls]:
                          !vimeoVideoId && shouldDisplayHtmlControls(image),
                        [classes.vimeoReactions]: !!vimeoVideoId,
                      })}
                      entityId={image.id}
                      entityType="image"
                      reactions={image.reactions}
                      metrics={{
                        likeCount: image.stats?.likeCountAllTime,
                        dislikeCount: image.stats?.dislikeCountAllTime,
                        heartCount: image.stats?.heartCountAllTime,
                        laughCount: image.stats?.laughCountAllTime,
                        cryCount: image.stats?.cryCountAllTime,
                      }}
                      targetUserId={image.user.id}
                      readonly={!safe}
                    />
                    {image.hasMeta && (
                      <div className="absolute bottom-2 right-2">
                        <ImageMetaPopover2 imageId={image.id} type={image.type}>
                          <ActionIcon variant="transparent" size="lg" component="span">
                            <IconInfoCircle
                              color="white"
                              filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                              opacity={0.8}
                              strokeWidth={2.5}
                              size={26}
                            />
                          </ActionIcon>
                        </ImageMetaPopover2>
                      </div>
                    )}
                  </>
                )}
              </ImageGuard2>
            </Paper>
            {i > 0 && (i - 1) % 3 === 0 && <AdUnitTop maxWidth={728} />}
          </Fragment>
        );
      })}
      {remainingImages > 0 && (
        <Button onClick={() => setShowMore(true)}>Load {remainingImages} more images</Button>
      )}
    </Stack>
  );
}

const useStyles = createStyles((theme) => ({
  reactions: {
    position: 'absolute',
    padding: 4,
    bottom: theme.spacing.sm,
    left: theme.spacing.sm,
    borderRadius: theme.radius.md,
    background:
      theme.colorScheme === 'dark'
        ? theme.fn.rgba(theme.colors.dark[6], 0.6)
        : theme.colors.gray[0],
    // backdropFilter: 'blur(13px) saturate(160%)',
    boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
  },
  reactionsWithControls: {
    bottom: 'initial',
    top: '32px',
    left: '8px',
  },

  vimeoReactions: {
    bottom: '48px',
    left: '8px',
  },

  vimeoContextMenu: {
    right: '40px',
    top: '10px',
  },
}));
