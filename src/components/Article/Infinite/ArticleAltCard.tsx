import { Badge, Box, Card, Group, Stack, Text } from '@mantine/core';
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
import classes from './ArticleAltCard.module.scss';

export function ArticleAltCard({ data, height, ...props }: Props) {
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
      <Card component="a" p={0} shadow="sm" withBorder className={classes.card} {...props}>
        <ArticleContextMenu article={data} className={classes.contextMenu} />
        {coverImage && (
          <ImageGuard2 image={coverImage}>
            {(safe) => (
              <div className={classes.imageContainer}>
                <Group spacing={4} className={classes.badgeGroup}>
                  <ImageGuard2.BlurToggle />
                  <Badge size="sm" className={classes.articleBadge}>
                    Article
                  </Badge>
                  {category && (
                    <Badge size="sm" className={classes.categoryBadge}>
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
                className={classes.userAvatarContainer}
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

