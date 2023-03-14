import { useState, useEffect } from 'react';
import { Container, Stack, Group } from '@mantine/core';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import { SortFilter, PeriodFilter } from '~/components/Filters';

export default function PostsPage() {
  return (
    <Container size="xl">
      <Stack>
        <Group position="apart">
          <SortFilter type="post" />
          <PeriodFilter />
        </Group>
        <PostsInfinite />
      </Stack>
    </Container>
  );
}
