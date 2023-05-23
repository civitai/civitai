import { Anchor, Group, Text } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import Link from 'next/link';

export function ImageConnectionLink({
  reviewId,
  modelId,
  children,
}: {
  reviewId?: number | null;
  modelId?: number | null;
  children?: React.ReactNode;
}) {
  if (!reviewId && !modelId) return null;

  return (
    <Link
      href={
        reviewId
          ? `/models/${modelId}?modal=reviewThread&reviewId=${reviewId}`
          : `/models/${modelId}`
      }
      passHref
    >
      <Anchor size="xs" target="_blank">
        {children ? (
          children
        ) : (
          <Group spacing={4} align="center">
            <Text inherit>{reviewId ? 'Go to review thread' : 'Go to model page'}</Text>
            <IconExternalLink size={14} />
          </Group>
        )}
      </Anchor>
    </Link>
  );
}
