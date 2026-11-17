import { Button } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';

/** Previous/Next around the current page number, for a list that knows only whether another page follows, not how many there are. */
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
    <nav aria-label="Reviews pages" className="mt-2 flex items-center justify-center gap-2">
      <Button
        variant="default"
        size="compact-md"
        leftSection={<IconChevronLeft size={16} />}
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        Previous
      </Button>
      <span
        aria-current="page"
        className="flex h-[30px] min-w-[34px] items-center justify-center rounded-md bg-blue-6 px-2 text-sm font-medium text-white"
      >
        {page}
      </span>
      <Button
        variant="default"
        size="compact-md"
        rightSection={<IconChevronRight size={16} />}
        disabled={!hasMore}
        onClick={() => onChange(page + 1)}
      >
        Next
      </Button>
    </nav>
  );
}
