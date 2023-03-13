import { useState, useEffect } from 'react';
import { Container } from '@mantine/core';
import PostsInfinite from '~/components/Post/Infinite/PostsInfinite';

export default function PostsPage() {
  return (
    <Container size="xl">
      <PostsInfinite />
    </Container>
  );
}
