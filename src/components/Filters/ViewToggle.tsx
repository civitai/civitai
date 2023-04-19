import { ActionIcon } from '@mantine/core';
import { IconLayoutGrid, IconLayoutList } from '@tabler/icons';
import { useRouter } from 'next/router';
import { IsClient } from '~/components/IsClient/IsClient';
import {
  ViewAdjustableTypes,
  useFiltersContext,
  useSetFilters,
  ViewMode,
} from '~/providers/FiltersProvider';
import { removeEmpty } from '~/utils/object-helpers';

type Props = {
  type: ViewAdjustableTypes;
};

export function ViewToggle({ type }: Props) {
  const { query, pathname, replace } = useRouter();
  const globalView = useFiltersContext((state) => state[type].view);
  const queryView = query.view as ViewMode | undefined;
  const setFilters = useSetFilters(type);

  const view = queryView ? queryView : globalView;
  const toggleView = () => {
    const newView = view === 'categories' ? 'feed' : 'categories';
    if (queryView && queryView !== newView)
      replace({ pathname, query: removeEmpty({ ...query, view: undefined }) }, undefined, {
        shallow: true,
      });
    setFilters({ view: newView });
  };

  return (
    <IsClient>
      <ActionIcon color="dark" variant="transparent" sx={{ width: 40 }} onClick={toggleView}>
        {view === 'categories' ? (
          <IconLayoutGrid size={20} stroke={2.5} />
        ) : (
          <IconLayoutList size={20} stroke={2.5} />
        )}
      </ActionIcon>
    </IsClient>
  );
}
