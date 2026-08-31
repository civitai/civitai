import { Button } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import { useRouter } from 'next/router';

function ClearButton({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <div className="flex">
      <Button
        variant="light"
        color="gray"
        size="compact-sm"
        rightSection={<IconX size={14} />}
        onClick={onClear}
        className="overflow-visible"
      >
        {label}
      </Button>
    </div>
  );
}

/**
 * The category scroller used to be the only thing that could unset `?tags=`. The param
 * still filters these feeds and is still linked to from elsewhere, so without this a
 * deep link narrows the feed with no way back to everything.
 *
 * `tagIds` is required rather than read from `router.query` here, so the control and the
 * feed beside it always answer to ONE parser. Every mount reads the param the way its own
 * feed does — and `useZodRouteParams` fails WHOLESALE on any one bad param, so a feed
 * whose `?sort=` is junk is not tag-filtered at all. Parsing the param here as well would
 * put a `Clear 1 tag filter` button over that unfiltered feed.
 */
export function ActiveTagFilter({ tagIds }: { tagIds: number[] }) {
  const router = useRouter();

  if (!tagIds.length) return null;

  const handleClear = () => {
    const { tags, ...query } = router.query;
    router.replace({ pathname: router.pathname, query }, undefined, {
      shallow: true,
      scroll: false,
    });
  };

  return (
    <ClearButton
      label={`Clear ${tagIds.length} tag filter${tagIds.length > 1 ? 's' : ''}`}
      onClear={handleClear}
    />
  );
}
