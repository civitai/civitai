import {
  Container,
  Stack,
  Title,
  Paper,
  Group,
  createStyles,
  ActionIcon,
  Badge,
  Button,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons';
import { NotFound } from '~/components/AppLayout/NotFound';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { PostComments } from '~/components/Post/Detail/PostComments';
import { Reactions } from '~/components/Reaction/Reactions';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { trpc } from '~/utils/trpc';
import { useState } from 'react';
import { PostControls } from '~/components/Post/Detail/PostControls';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';

const maxWidth = 700;
const maxInitialImages = 20;
export function PostDetail({ postId }: { postId: number }) {
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();
  const { data, isLoading } = trpc.post.get.useQuery({ id: postId });

  const [showMore, setShowMore] = useState(false);

  if (isLoading) return <PageLoader />;
  if (!data) return <NotFound />;

  const remainingImages = data.images.length - maxInitialImages;

  return (
    <Container size="sm">
      <Stack>
        <Group position="apart" noWrap align="top">
          {data.title ? (
            <Title sx={{ lineHeight: 1 }} order={2}>
              {data.title}
            </Title>
          ) : (
            <span></span>
          )}
          <PostControls postId={data.id} userId={data.user.id} />
        </Group>
        {data.detail && (
          <ContentClamp maxHeight={300}>
            <RenderHtml html={data.detail} withMentions />
          </ContentClamp>
        )}
        <Stack>
          <ImageGuard
            connect={{ entityId: postId, entityType: 'post' }}
            images={showMore ? data.images : data.images.slice(0, maxInitialImages)}
            render={(image) => {
              const width = image.width ?? maxWidth;
              return (
                <Paper key={image.id} radius="md" className={classes.frame}>
                  <ImageGuard.ToggleConnect
                    sx={(theme) => ({
                      backgroundColor: theme.fn.rgba(theme.colors.red[9], 0.4),
                      color: 'white',
                      backdropFilter: 'blur(7px)',
                      boxShadow: '1px 2px 3px -1px rgba(37,38,43,0.2)',
                    })}
                  />
                  <ImageGuard.Unsafe>
                    <div className={classes.imageContainer}>
                      <EdgeImage
                        src={image.url}
                        name={image.name}
                        alt={image.name ?? undefined}
                        width={width < maxWidth ? width : maxWidth}
                        className={classes.blur}
                      />
                    </div>
                  </ImageGuard.Unsafe>
                  <ImageGuard.Safe>
                    <EdgeImage
                      src={image.url}
                      name={image.name}
                      alt={image.name ?? undefined}
                      width={width < maxWidth ? width : maxWidth}
                    />
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
                    />
                  </ImageGuard.Safe>
                  {image.meta && !image.hideMeta && (
                    <ImageMetaPopover
                      meta={image.meta as ImageMetaProps}
                      generationProcess={image.generationProcess ?? 'txt2img'}
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
              );
            }}
          />
          {remainingImages > 0 && (
            <Button onClick={() => setShowMore(true)}>Load {remainingImages} more images</Button>
          )}
        </Stack>
        <Stack spacing="xl">
          <Group spacing="xs">
            {data.tags.map((tag) => (
              <Badge key={tag.id} size="lg">
                {tag.name}
              </Badge>
            ))}
          </Group>
          <PostComments postId={postId} userId={data.user.id} />
        </Stack>
      </Stack>
    </Container>
  );
}

const useStyles = createStyles((theme) => ({
  frame: {
    position: 'relative',
    overflow: 'hidden',
    background: theme.colorScheme === 'dark' ? theme.colors.dark[9] : theme.colors.gray[1],
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 100,
  },
  imageContainer: {
    display: 'inline',
    overflow: 'hidden',
  },
  blur: {
    filter: 'blur(40px)',
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
    backdropFilter: 'blur(13px) saturate(160%)',
    boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
  },
  meta: {
    position: 'absolute',
    bottom: theme.spacing.sm,
    right: theme.spacing.sm,
  },
}));
