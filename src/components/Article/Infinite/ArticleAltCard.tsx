import { Badge, Box, Card, Group, Stack, Text, createStyles } from '@mantine/core';
import { IconBookmark, IconEye, IconMessageCircle2, IconMoodSmile } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useRouter } from 'next/router';

import { CivitaiTooltip } from '~/components/CivitaiWrapped/CivitaiTooltip';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { abbreviateNumber } from '~/utils/number-helpers';
import { slugit } from '~/utils/string-helpers';
import { ArticleContextMenu } from '../ArticleContextMenu';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { AssociatedResourceArticleCardData } from '~/server/controllers/model.controller';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';

export function ArticleAltCard({ data, height, ...props }: Props) {
  const { classes } = useStyles();
  const router = useRouter();

  const { id, title, coverImage, tags, stats } = data;
  const category = tags?.find((tag) => tag.isCategory);
  const { commentCount, viewCount, favoriteCount, ...reactionStats } = stats || {
    commentCount: 0,
    viewCount: 0,
    favoriteCount: 0,
    likeCount: 0,
  };
  const reactionCount = Object.values(reactionStats).reduce((a, b) => a + b, 0);

  return (
    <Link legacyBehavior href={`/articles/${id}/${slugit(title)}`} passHref>
      <Card
        component="a"
        p={0}
        shadow="sm"
        withBorder
        sx={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        {...props}
      >
        <ArticleContextMenu
          article={data}
          sx={{
            width: 30,
            position: 'absolute',
            top: 10,
            right: 4,
            zIndex: 8,
          }}
        />
        {coverImage && (
          <ImageGuard2 image={coverImage}>
            {(safe) => (
              <div className="relative h-full flex-1 overflow-hidden">
                <Group spacing={4} className="absolute left-2 top-2 z-10">
                  <ImageGuard2.BlurToggle />
                  <Badge
                    size="sm"
                    sx={{
                      background: 'rgb(30 133 230 / 40%)',
                      color: 'white',
                      // backdropFilter: 'blur(7px)',
                      boxShadow: '1px 2px 3px -1px rgba(37,38,43,0.2)',
                    }}
                  >
                    Article
                  </Badge>
                  {category && (
                    <Badge size="sm" variant="gradient" gradient={{ from: 'cyan', to: 'blue' }}>
                      {category.name}
                    </Badge>
                  )}
                </Group>
                {!safe ? (
                  <MediaHash {...coverImage} />
                ) : (
                  <EdgeMedia
                    className={classes.image}
                    src={coverImage.url}
                    width={450}
                    loading="lazy"
                  />
                )}
              </div>
            )}
          </ImageGuard2>
        )}
        <Stack className={classes.info} spacing={8}>
          {data.user.image && (
            <CivitaiTooltip
              position="left"
              transition="slide-left"
              variant="smallRounded"
              label={
                <Text size="xs" weight={500}>
                  {data.user.username}
                </Text>
              }
            >
              <Box
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  router.push(`/user/${data.user.username}`);
                }}
                sx={{ borderRadius: '50%' }}
                ml="auto"
                mr="xs"
              >
                <UserAvatar
                  size="md"
                  user={data.user}
                  avatarProps={{ className: classes.userAvatar }}
                />
              </Box>
            </CivitaiTooltip>
          )}
          <Stack className={classes.content} spacing={6} p="xs">
            <Text size={14} weight={500} color="white" lineClamp={2} lh={1.2}>
              {title}
            </Text>
            <Group position="apart">
              <Group spacing={4}>
                <IconBadge icon={<IconBookmark size={14} />} className={classes.statBadge}>
                  <Text size="xs">{abbreviateNumber(favoriteCount)}</Text>
                </IconBadge>
                <IconBadge icon={<IconMoodSmile size={14} />} className={classes.statBadge}>
                  <Text size="xs">{abbreviateNumber(reactionCount)}</Text>
                </IconBadge>
                <IconBadge icon={<IconMessageCircle2 size={14} />} className={classes.statBadge}>
                  <Text size="xs">{abbreviateNumber(commentCount)}</Text>
                </IconBadge>
              </Group>
              <IconBadge icon={<IconEye size={14} />} className={classes.statBadge}>
                <Text size="xs">{abbreviateNumber(viewCount)}</Text>
              </IconBadge>
            </Group>
          </Stack>
        </Stack>
      </Card>
    </Link>
  );
}

type Props = {
  data: AssociatedResourceArticleCardData;
  height?: number;
} & ElementDataAttributes;

const useStyles = createStyles((theme) => ({
  image: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },

  info: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    left: 0,
    zIndex: 10,
  },

  content: {
    background: theme.fn.gradient({
      from: 'rgba(37,38,43,0.8)',
      to: 'rgba(37,38,43,0)',
      deg: 0,
    }),
    // backdropFilter: 'blur(13px) saturate(160%)',
    boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
  },

  statBadge: {
    background: 'rgba(212,212,212,0.2)',
    color: 'white',
  },

  userAvatar: {
    opacity: 0.8,
    boxShadow: '0 1px 3px rgb(0 0 0 / 50%), rgb(0 0 0 / 50%) 0px 8px 15px -5px',
    transition: 'opacity .25s ease',
    position: 'relative',

    '&::before': {
      content: '""',
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      borderRadius: theme.radius.xl,
      boxShadow: 'inset 0 0 0px 1px rgba(255,255,255,0.8)',
    },

    '&:hover': {
      opacity: 1,
    },
  },
}));
