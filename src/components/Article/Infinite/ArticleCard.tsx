import { Badge, Box, Card, Group, Stack, Text, createStyles } from '@mantine/core';
import { IconBookmark, IconEye, IconMessageCircle2, IconMoodSmile } from '@tabler/icons-react';
import Link from 'next/link';

import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { ArticleGetAll } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { abbreviateNumber } from '~/utils/number-helpers';
import { slugit } from '~/utils/string-helpers';
import { ArticleContextMenu } from '../ArticleContextMenu';

export function ArticleCard({ data, height = 450 }: Props) {
  const { id, title, cover, publishedAt, user, tags, stats } = data;
  const category = tags?.find((tag) => tag.isCategory);
  const { commentCount, viewCount, favoriteCount, ...reactionStats } = stats || {
    commentCount: 0,
    viewCount: 0,
    favoriteCount: 0,
    likeCount: 0,
  };
  const reactionCount = Object.values(reactionStats).reduce((a, b) => a + b, 0);
  const { classes } = useStyles();

  return (
    <Link href={`/articles/${id}/${slugit(title)}`} passHref>
      <Card
        component="a"
        p={0}
        shadow="sm"
        withBorder
        sx={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      >
        <Stack spacing={0} sx={{ height: '100%' }}>
          {/* <Card.Section py="xs" inheritPadding> */}
          <Group position="apart" px="sm" py="xs">
            <UserAvatar
              user={user}
              size="sm"
              subText={publishedAt ? formatDate(publishedAt) : 'Draft'}
              withUsername
            />
            <ArticleContextMenu article={data} />
          </Group>
          {/* </Card.Section> */}
          <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
            {category && (
              <Badge
                size="sm"
                variant="gradient"
                gradient={{ from: 'cyan', to: 'blue' }}
                sx={(theme) => ({
                  position: 'absolute',
                  top: theme.spacing.xs,
                  right: theme.spacing.xs,
                  zIndex: 1,
                })}
              >
                {category.name}
              </Badge>
            )}
            {/* <Box sx={{ height: height / 2, '& > img': { height: '100%', objectFit: 'cover' } }}>
            </Box> */}
            <EdgeMedia className={classes.image} src={cover} width={450} />
          </div>
          {/* <Card.Section py="xs" inheritPadding> */}
          <Stack spacing={4} px="sm" py="xs">
            <Text lineClamp={2}>{title}</Text>
            <Group position="apart">
              <Group spacing={4}>
                <IconBadge icon={<IconBookmark size={14} />} color="dark">
                  <Text size="xs">{abbreviateNumber(favoriteCount)}</Text>
                </IconBadge>
                <IconBadge icon={<IconMoodSmile size={14} />} color="dark">
                  <Text size="xs">{abbreviateNumber(reactionCount)}</Text>
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
          {/* </Card.Section> */}
        </Stack>
      </Card>
    </Link>
  );
}

type Props = {
  data: ArticleGetAll['items'][number];
  height?: number;
};

const useStyles = createStyles((theme) => ({
  header: {},
  image: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
}));
