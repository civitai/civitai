import { Tabs, Text } from '@mantine/core';
import { useCrucibleFilters, useCrucibleQueryParams } from '~/components/Crucible/crucible.utils';
import { CrucibleSort } from '~/server/common/enums';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';

// Filter presets that combine status and sort
export type CrucibleFilterPreset = 'featured' | 'ending-soon' | 'high-stakes' | 'new';

const filterPresets: { value: CrucibleFilterPreset; label: string }[] = [
  { value: 'featured', label: 'Featured' },
  { value: 'ending-soon', label: 'Ending Soon' },
  { value: 'high-stakes', label: 'High Stakes' },
  { value: 'new', label: 'New' },
];

// Map presets to filter combinations
function getFiltersFromPreset(preset: CrucibleFilterPreset): {
  status?: CrucibleStatus;
  sort?: CrucibleSort;
} {
  switch (preset) {
    case 'featured':
      return { status: CrucibleStatus.Active, sort: CrucibleSort.PrizePool };
    case 'ending-soon':
      return { status: CrucibleStatus.Active, sort: CrucibleSort.EndingSoon };
    case 'high-stakes':
      return { status: CrucibleStatus.Active, sort: CrucibleSort.PrizePool };
    case 'new':
      return { sort: CrucibleSort.Newest };
    default:
      return {};
  }
}

// Determine active preset from current filters
function getPresetFromFilters(filters: {
  status?: CrucibleStatus;
  sort?: CrucibleSort;
}): CrucibleFilterPreset {
  const { status, sort } = filters;

  // Check for ending-soon first (Active + EndingSoon sort)
  if (status === CrucibleStatus.Active && sort === CrucibleSort.EndingSoon) {
    return 'ending-soon';
  }

  // Check for new (Newest sort, any status)
  if (sort === CrucibleSort.Newest) {
    return 'new';
  }

  // Check for high-stakes (Active + PrizePool sort) - also the default for featured
  if (status === CrucibleStatus.Active && sort === CrucibleSort.PrizePool) {
    return 'featured';
  }

  // Default to featured
  return 'featured';
}

export function CrucibleFilterTabs() {
  const filters = useCrucibleFilters();
  const { replace } = useCrucibleQueryParams();

  const currentPreset = getPresetFromFilters(filters);

  const handleTabChange = (value: string | null) => {
    if (value) {
      const newFilters = getFiltersFromPreset(value as CrucibleFilterPreset);
      replace(newFilters);
    }
  };

  return (
    <Tabs
      value={currentPreset}
      onChange={handleTabChange}
      classNames={{
        root: 'border-b border-dark-4',
        list: 'gap-0 border-0',
        tab: 'px-4 py-3 text-base font-normal text-dimmed border-b-2 border-transparent data-[active]:text-blue-5 data-[active]:border-blue-5 data-[active]:font-medium hover:text-white transition-colors bg-transparent',
      }}
    >
      <Tabs.List>
        {filterPresets.map((preset) => (
          <Tabs.Tab key={preset.value} value={preset.value}>
            <Text size="sm">{preset.label}</Text>
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs>
  );
}
