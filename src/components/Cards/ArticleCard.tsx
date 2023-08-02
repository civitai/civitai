import { Badge, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import React from 'react';
import { FeedCard } from '~/components/Cards/FeedCard';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useRouter } from 'next/router';
import { IconBookmark, IconEye, IconMessageCircle2 } from '@tabler/icons-react';
import { abbreviateNumber } from '~/utils/number-helpers';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { slugit } from '~/utils/string-helpers';
import { formatDate } from '~/utils/date-helpers';
import { ArticleGetAll } from '~/types/router';
import { ArticleContextMenu } from '~/components/Article/ArticleContextMenu';

const IMAGE_CARD_WIDTH = 332;

export function ArticleCard({ data }: Props) {
  const { classes, cx } = useCardStyles({ aspectRatio: 1 });
  const router = useRouter();
  const { id, title, cover, publishedAt, user, tags, stats } = data;
  const category = tags?.find((tag) => tag.isCategory);
  const { commentCount, viewCount, favoriteCount } = stats || {
    commentCount: 0,
    viewCount: 0,
    favoriteCount: 0,
    likeCount: 0,
  };

  return (
    <FeedCard href={`/articles/${id}/${slugit(title)}`} aspectRatio="landscape">
      <div className={classes.root}>
        <Group
          spacing={4}
          position="apart"
          className={cx(classes.contentOverlay, classes.top)}
          noWrap
        >
          {category && (
            <Badge
              color="dark"
              size="sm"
              variant="light"
              radius="xl"
              sx={(theme) => ({
                position: 'absolute',
                top: theme.spacing.xs,
                left: theme.spacing.xs,
                zIndex: 1,
              })}
            >
              {category.name}
            </Badge>
          )}
          <ArticleContextMenu article={data} ml="auto" />
        </Group>
        {cover && (
          <EdgeImage
            src={cover}
            width={IMAGE_CARD_WIDTH}
            placeholder="empty"
            className={classes.image}
            loading="lazy"
          />
        )}
        <Stack
          className={cx(classes.contentOverlay, classes.bottom, classes.fullOverlay)}
          spacing="sm"
        >
          {user?.id !== -1 && (
            <UnstyledButton
              sx={{ color: 'white' }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();

                router.push(`/user/${user.username}`);
              }}
            >
              <UserAvatar user={user} avatarProps={{ radius: 'md', size: 32 }} withUsername />
            </UnstyledButton>
          )}
          <Stack spacing={0}>
            {publishedAt && (
              <Text size="xs" weight={500} color="white" inline>
                {formatDate(publishedAt)}
              </Text>
            )}
            {title && (
              <Text size="xl" weight={700} lineClamp={2} lh={1.2}>
                {title}
              </Text>
            )}
          </Stack>
          <Group position="apart">
            <Group spacing={4}>
              <IconBadge icon={<IconBookmark size={14} />} color="dark">
                <Text size="xs">{abbreviateNumber(favoriteCount)}</Text>
              </IconBadge>
              <IconBadge icon={<IconMessageCircle2 size={14} />} color="dark">
                <Text size="xs">{abbreviateNumber(commentCount)}</Text>
              </IconBadge>
            </Group>
            <IconBadge icon={<IconEye size={14} />} color="dark">
              <Text size="xs">{abbreviateNumber(viewCount)}</Text>
            </IconBadge>
          </Group>
        </Stack>
      </div>
    </FeedCard>
  );
}

type Props = { data: ArticleGetAll['items'][0] };
