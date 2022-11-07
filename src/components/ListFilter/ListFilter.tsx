import { ActionIcon, Popover, Stack, Checkbox } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconFilter } from '@tabler/icons';
import { useModelFilters } from '~/hooks/useModelFilters';
import { splitUppercase } from '~/utils/string-helpers';

export function ListFilter() {
  const { filters, setFilters } = useModelFilters();

  return (
    <Popover withArrow>
      <Popover.Target>
        <ActionIcon>
          <IconFilter size={18} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack>
          <Checkbox.Group
            value={filters.types ?? []}
            label="Model types"
            orientation="vertical"
            spacing="xs"
            size="md"
            onChange={(types: ModelType[]) => setFilters((state) => ({ ...state, types }))}
          >
            {Object.values(ModelType).map((type, index) => (
              <Checkbox key={index} value={type} label={splitUppercase(type)} />
            ))}
          </Checkbox.Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
