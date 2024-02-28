import {
  Stack,
  Paper,
  createStyles,
  ActionIcon,
  Button,
  Center,
  Loader,
  Alert,
  Group,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { Reactions } from '~/components/Reaction/Reactions';
import { useState } from 'react';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { truncate } from 'lodash-es';
import { constants } from '~/server/common/constants';

const maxWidth = 700;
const maxInitialImages = 20;
export function PostImages({
  postId,
  images,
  isLoading,
}: {
  postId: number;
  images: ImagesInfiniteModel[];
  isLoading?: boolean;
}) {
  const { classes, cx } = useStyles();
  const [showMore, setShowMore] = useState(false);

  if (isLoading)
    return (
      <Paper component={Center} p="xl" mih={300} withBorder>
        <Group>
          <Loader />
          Loading Images
        </Group>
      </Paper>
    );
  if (!images?.length)
    return (
      <Alert>Due to your filter settings, we could not display any images from this post</Alert>
    );

  const remainingImages = images.length - maxInitialImages;
  const _images = showMore ? images : images.slice(0, maxInitialImages);

  return (
    <Stack>
      <ImageGuard
        connect={{ entityId: postId, entityType: 'post' }}
        images={_images}
        render={(image) => {
          const width = image.width ?? maxWidth;
          return (
            <RoutedDialogLink name="imageDetail" state={{ imageId: image.id, images }}>
              <Paper
                radius="md"
                className={classes.frame}
                shadow="md"
                mx="auto"
                style={{
                  maxWidth: '100%',
                  width: width < maxWidth ? width : maxWidth,
                  aspectRatio:
                    image.width && image.height ? `${image.width}/${image.height}` : undefined,
                }}
              >
                <ImageGuard.ToggleConnect position="top-left" />
                <ImageGuard.Report />
                <ImageGuard.Content>
                  {({ safe }) => (
                    <>
                      {!safe ? (
                        <div
                          style={{
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            aspectRatio: (image.width ?? 0) / (image.height ?? 0),
                          }}
                        >
                          <MediaHash {...image} />
                        </div>
                      ) : (
                        <EdgeMedia
                          src={image.url}
                          name={image.name}
                          alt={
                            image.meta
                              ? truncate(image.meta.prompt, { length: constants.altTruncateLength })
                              : image.name ?? undefined
                          }
                          type={image.type}
                          width={width < maxWidth ? width : maxWidth}
                          anim={safe}
                        />
                      )}

                      <Reactions
                        p={4}
                        className={classes.reactions}
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
                    </>
                  )}
                </ImageGuard.Content>

                {image.meta && !image.hideMeta && (
                  <ImageMetaPopover
                    meta={image.meta}
                    generationProcess={image.generationProcess ?? 'txt2img'}
                    imageId={image.id}
                    mainResourceId={image.modelVersionId ?? undefined}
                  >
                    <ActionIcon variant="transparent" size="lg" className={classes.meta}>
                      <IconInfoCircle
                        color="white"
                        filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                        opacity={0.8}
                        strokeWidth={2.5}
                        size={26}
                      />
                    </ActionIcon>
                  </ImageMetaPopover>
                )}
              </Paper>
            </RoutedDialogLink>
          );
        }}
      />
      {remainingImages > 0 && (
        <Button onClick={() => setShowMore(true)}>Load {remainingImages} more images</Button>
      )}
    </Stack>
  );
}

const useStyles = createStyles((theme) => ({
  frame: {
    position: 'relative',
    overflow: 'hidden',
  },
  imageContainer: {
    display: 'inline',
    overflow: 'hidden',
  },
  reactions: {
    position: 'absolute',
    bottom: theme.spacing.sm,
    left: theme.spacing.sm,
    borderRadius: theme.radius.md,
    background: theme.fn.rgba(
      theme.colorScheme === 'dark' ? theme.colors.dark[9] : theme.colors.gray[0],
      0.8
    ),
    // backdropFilter: 'blur(13px) saturate(160%)',
    boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
  },
  meta: {
    position: 'absolute',
    bottom: theme.spacing.sm,
    right: theme.spacing.sm,
  },
}));
