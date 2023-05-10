import { Badge, Box, Card, Group, Stack, Text } from '@mantine/core';
import { IconEye, IconHeart } from '@tabler/icons';
import Link from 'next/link';

import { IconBadge } from '~/components/IconBadge/IconBadge';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { ArticleGetAll } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { slugit } from '~/utils/string-helpers';

import { ArticleContextMenu } from '../ArticleContextMenu';

export function ArticleCard({ data, height = 450 }: Props) {
  const { id, title, cover, publishedAt, user, tags } = data;
  const category = tags?.find((tag) => tag.isCategory);

  return (
    <Link href={`/articles/${id}/${slugit(title)}`} passHref>
      <Card component="a" p="sm" shadow="sm" withBorder>
        <Card.Section py="xs" inheritPadding>
          <Group position="apart">
            <UserAvatar
              user={user}
              size="sm"
              subText={publishedAt ? formatDate(publishedAt) : 'Draft'}
              withUsername
            />
            <ArticleContextMenu article={data} />
          </Group>
        </Card.Section>
        <Card.Section style={{ position: 'relative' }}>
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
          <Box sx={{ height: height / 2, '& > img': { height: '100%', objectFit: 'cover' } }}>
            <EdgeImage src={cover} width={450} />
          </Box>
        </Card.Section>
        <Card.Section py="xs" inheritPadding>
          <Stack spacing={4}>
            <Text lineClamp={2}>{title}</Text>
            <Group position="apart">
              <IconBadge icon={<IconHeart size={14} />} color="dark">
                <Text size="xs">10K</Text>
              </IconBadge>
              <IconBadge icon={<IconEye size={14} />} color="dark">
                <Text size="xs">2.1M</Text>
              </IconBadge>
            </Group>
          </Stack>
        </Card.Section>
      </Card>
    </Link>
  );
}

type Props = {
  data: ArticleGetAll['items'][number];
  height?: number;
};
