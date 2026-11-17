import { Badge } from '@mantine/core';
import { IconHeart } from '@tabler/icons-react';

/** Read-only reaction total for a published post's image; renders nothing when there is no count. */
export function ImageReactionCount({
  count,
  className,
}: {
  count?: number | null;
  className?: string;
}) {
  if (count == null) return null;
  return (
    <Badge
      size="lg"
      color="dark"
      variant="filled"
      leftSection={<IconHeart size={14} />}
      className={className}
      aria-label={`${count} reactions`}
    >
      {count}
    </Badge>
  );
}
