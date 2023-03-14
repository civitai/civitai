import { useState, useEffect } from 'react';
import { Container, Stack, Group } from '@mantine/core';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';
import {
  PostsFilterProvider,
  PostsPeriod,
  PostsSort,
} from '~/components/Post/Infinite/PostFilters';

export default function PostsPage() {
  return (
    <Container size="xl">
      <PostsFilterProvider>
        <Stack>
          <Group position="apart">
            <PostsSort />
            <PostsPeriod />
          </Group>
          <PostsInfinite />
        </Stack>
      </PostsFilterProvider>
    </Container>
  );
}
