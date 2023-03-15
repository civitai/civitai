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
      my={5}
      size="xs"
      color="blue"
      styles={(theme) => ({
        root: {
          border: `1px solid ${
            theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[4]
          }`,
          background: 'none',
        },
      })}
      {...props}
    />
  );
}
