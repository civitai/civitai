import { Button, Group } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';

/** Previous/Next for a list that knows only whether another page follows, not how many there are. */
export function ReviewsPager({
  page,
  hasMore,
  onChange,
}: {
  page: number;
  hasMore: boolean;
  onChange: (page: number) => void;
}) {
  if (page <= 1 && !hasMore) return null;

  return (
    <Group justify="center" mt="md">
      <Button
        variant="default"
        leftSection={<IconChevronLeft size={16} />}
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        Previous
      </Button>
      <Button
        variant="default"
        rightSection={<IconChevronRight size={16} />}
        disabled={!hasMore}
        onClick={() => onChange(page + 1)}
      >
        Next
      </Button>
    </Group>
  );
}
