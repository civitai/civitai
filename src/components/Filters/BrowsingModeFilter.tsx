import { SegmentedControl, SegmentedControlProps } from '@mantine/core';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { BrowsingMode } from '~/server/common/enums';

const options = [
  { label: 'Safe', value: BrowsingMode.SFW },
  { label: 'Adult', value: BrowsingMode.NSFW },
  { label: 'Everything', value: BrowsingMode.All },
];

type Props = Omit<SegmentedControlProps, 'data' | 'value' | 'onChange'>;

export function BrowsingModeFilter(props: Props) {
  const browsingMode = useFiltersContext((state) => state.browsingMode);
  const setFilters = useFiltersContext((state) => state.setFilters);

  return (
    <SegmentedControl
      data={options}
      value={browsingMode}
      onChange={(mode: BrowsingMode) => setFilters({ browsingMode: mode })}
      {...props}
    />
  );
}
