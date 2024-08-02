import { Button, Group, Stack, useMantineTheme } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconChevronLeft } from '@tabler/icons-react';
import { Announcements } from '~/components/Announcements/Announcements';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { usePostQueryParams } from '~/components/Post/post.utils';
import { constants } from '~/server/common/constants';

export default function PostFeed() {
  const { query } = usePostQueryParams();
  const theme = useMantineTheme();

  return (
    <MasonryProvider
      columnWidth={constants.cardSizes.image}
      maxColumnCount={7}
      maxSingleColumnWidth={450}
    >
      <MasonryContainer>
        <Announcements />
        <Stack spacing="xs">
          <Group position="apart" spacing={8}>
            <SortFilter type="posts" />
            <PeriodFilter type="posts" />
          </Group>
          <Group>
            <Button
              component={NextLink}
              href="/posts"
              variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
              color="gray"
              pl={2}
              compact
            >
              <Group spacing={4}>
                <IconChevronLeft />
                Back to Categories
              </Group>
            </Button>
          </Group>
          <PostsInfinite filters={query} />
        </Stack>
      </MasonryContainer>
    </MasonryProvider>
  );
}
