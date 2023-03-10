import {
  Container,
  Stack,
  Title,
  Paper,
  Group,
  Card,
  Text,
  Center,
  Loader,
  createStyles,
  ActionIcon,
  Badge,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons';
import { NotFound } from '~/components/AppLayout/NotFound';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { PostComments } from '~/components/Post/Detail/PostComments';
import { Reactions } from '~/components/Reaction/Reactions';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { trpc } from '~/utils/trpc';

const maxWidth = 700;
export function PostDetail({ postId }: { postId: number }) {
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();
  const { data, isLoading } = trpc.post.get.useQuery({ id: postId });

  if (isLoading) return <PageLoader />;
  if (!data) return <NotFound />;

  return (
    <Container size="sm">
      <Stack>
        {data.title && <Title>{data.title}</Title>}
        <Stack>
          {data.images.map((image) => {
            const width = image.width ?? maxWidth;
            return (
              <Paper key={image.id} radius="md" className={classes.frame}>
                <EdgeImage src={image.url} width={width < maxWidth ? width : maxWidth} />
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
          })}
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
