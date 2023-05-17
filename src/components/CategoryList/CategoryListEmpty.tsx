import { Center, Stack, Text } from '@mantine/core';
import { NextLink } from '@mantine/next';

const typeCreate = {
  article: {
    link: '/articles/create?category=',
    text: 'write an article',
  },
  image: {
    link: '/posts/create?tag=',
    text: 'make a post',
  },
  post: {
    link: '/posts/create?tag=',
    text: 'make a post',
  },
  model: {
    link: '/models/create?category=',
    text: 'upload a model',
  },
} as const;
type ListType = keyof typeof typeCreate;

export function CategoryListEmpty({ type, categoryId }: { type: ListType; categoryId: number }) {
  const { link, text } = typeCreate[type];
  return (
    <Center style={{ height: '100%' }}>
      <Stack align="center" spacing={4}>
        <Text size={32} align="center" lh={1} mb="xs">
          {`¯\\_(ツ)_/¯`}
        </Text>
        <Text size={24} align="center" lh={1}>
          {`There's nothing here...`}
        </Text>
        <Text align="center" lh={1}>
          Try adjusting your filters or{' '}
          <Text component={NextLink} href={link + categoryId} variant="link">
            {text}
          </Text>
        </Text>
        <Text align="center" lh={1} size="xs" color="dimmed">
          <Text component="span" fs="italic">
            This could be your time to shine!
          </Text>{' '}
          🤩
        </Text>
      </Stack>
    </Center>
  );
}
