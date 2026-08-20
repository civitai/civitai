import { Button } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import { useRouter } from 'next/router';

import { useModelQueryParams } from '~/components/Model/model.utils';
import { parseNumericStringArray } from '~/utils/query-string-helpers';

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
 */
export function ActiveTagFilter() {
  const router = useRouter();
  const tagIds = parseNumericStringArray(router.query.tags) ?? [];

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

/** `/models` carries the tag by name in `?tag=` rather than by id. */
export function ActiveModelTagFilter() {
  const { tag, set } = useModelQueryParams();

  if (!tag) return null;

  return <ClearButton label={`Clear tag: ${tag}`} onClear={() => set({ tag: undefined })} />;
}
