import { Button, Text } from '@mantine/core';
import { IconFilterOff } from '@tabler/icons-react';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { useFiltersContext } from '~/providers/FiltersProvider';

/** Hide Paid persists per browser, so the feed says when it is on and offers the way out. */
export function HidePaidNotice() {
  const { set: setQueryParams, hidePaid: urlHidePaid } = useModelQueryParams();
  const setModelFilters = useFiltersContext((state) => state.setModelFilters);

  const showAll = () => {
    setModelFilters({ hidePaid: undefined });
    if (urlHidePaid !== undefined) setQueryParams({ hidePaid: undefined });
  };

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-gray-1 px-3 py-2 dark:bg-dark-6"
    >
      <IconFilterOff size={16} className="shrink-0" aria-hidden />
      <Text size="sm" className="min-w-0 flex-1">
        Hiding paid models. Models with a free version show that version.
      </Text>
      <Button size="compact-sm" variant="light" onClick={showAll}>
        Show all
      </Button>
    </div>
  );
}
