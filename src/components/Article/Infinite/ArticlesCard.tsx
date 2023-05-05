import { ActionIcon, Card, Group, Image, Menu, Stack, Text } from '@mantine/core';
import { IconDotsVertical, IconEye, IconHeart } from '@tabler/icons';
import Link from 'next/link';

import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { ArticleGetAll } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { slugit } from '~/utils/string-helpers';

export function ArticlesCard({ data, height }: Props) {
  const { id, title, cover, publishedAt, user } = data;

  return (
    <Link href={`/articles/${id}/${slugit(title)}`} passHref>
      <Card component="a" p="sm" shadow="sm" withBorder>
        <Card.Section py="xs" inheritPadding>
          <Group position="apart">
            <UserAvatar
              user={user}
              size="sm"
              subText={publishedAt ? formatDate(publishedAt) : ''}
              withUsername
            />
            <Menu>
              <Menu.Target>
                <ActionIcon
                  variant="transparent"
                  p={0}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  <IconDotsVertical size={24} />
                </ActionIcon>
              </Menu.Target>
            </Menu>
          </Group>
        </Card.Section>
        <Card.Section>
          <Image src={cover} height={height / 2} alt={title} />
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
  index: number;
  data: ArticleGetAll['items'][number];
  width: number;
  height: number;
};
