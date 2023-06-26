import { ActionIcon, AspectRatio, Box, createStyles } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { PostReactions } from '~/components/Reaction/Reactions';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { PostGetByCategoryPostModel } from '~/types/router';

export function PostCategoryCard({ data }: { data: PostGetByCategoryPostModel }) {
  const { classes } = useStyles();
  return (
    <ImageGuard
      images={[data.image]}
      connect={{ entityId: data.id, entityType: 'post' }}
      render={(image) => (
        <ImageGuard.Content>
          {({ safe }) => (
            <div className={classes.container}>
              <ImageGuard.Report />
              <ImageGuard.ToggleConnect className={classes.toggle} />
              <RoutedContextLink modal="postDetailModal" postId={data.id} className={classes.link}>
                <AspectRatio
                  ratio={1}
                  sx={(theme) => ({
                    width: '100%',
                    borderRadius: theme.radius.md,
                    overflow: 'hidden',
                  })}
                >
                  <Box className={classes.blur}>
                    <MediaHash {...image} />
                  </Box>
                  {safe && (
                    <EdgeImage
                      src={image.url}
                      name={image.name ?? image.id.toString()}
                      alt={image.name ?? undefined}
                      width={450}
                      placeholder="empty"
                      className={classes.image}
                    />
                  )}
                </AspectRatio>
              </RoutedContextLink>

              <PostReactions
                className={classes.reactions}
                imageCount={data.imageCount}
                metrics={{
                  likeCount: data.likeCount,
                  dislikeCount: data.dislikeCount,
                  heartCount: data.heartCount,
                  laughCount: data.laughCount,
                  cryCount: data.cryCount,
                }}
              />
              {!image.hideMeta && image.meta && (
                <ImageMetaPopover
                  meta={image.meta as any}
                  generationProcess={image.generationProcess ?? undefined}
                  imageId={image.id}
                >
                  <ActionIcon className={classes.info} variant="transparent" size="lg">
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
            </div>
          )}
        </ImageGuard.Content>
      )}
    />
  );
}

const useStyles = createStyles((theme) => ({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },

  viewMore: {
    maxHeight: '100%',
    height: 500,
    width: '100%',
  },

  footer: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    background: theme.fn.gradient({
      from: 'rgba(37,38,43,0.8)',
      to: 'rgba(37,38,43,0)',
      deg: 0,
    }),
    backdropFilter: 'blur(13px) saturate(160%)',
    boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
    zIndex: 10,
    gap: 6,
    padding: theme.spacing.xs,
  },
  link: {
    width: '100%',
    display: 'flex',
    justifyContent: 'center',
  },
  toggle: {
    left: 10,
  },
  reactions: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    borderRadius: theme.radius.sm,
    background: theme.fn.rgba(
      theme.colorScheme === 'dark' ? theme.colors.dark[9] : theme.colors.gray[0],
      0.8
    ),
    backdropFilter: 'blur(13px) saturate(160%)',
    boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
    padding: 4,
  },
  info: {
    position: 'absolute',
    bottom: 5,
    right: 5,
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
}));
