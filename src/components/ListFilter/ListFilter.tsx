import { ActionIcon, Popover } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconFilter } from '@tabler/icons';
import { splitUppercase } from '~/utils/string-helpers';

export function ListFilter() {
  const typeOptions = Object.values(ModelType).map((type) => ({
    label: splitUppercase(type),
    value: type,
  }));

  return (
    <Popover withArrow>
      <Popover.Target>
        <ActionIcon>
          <IconFilter size={18} />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown>Test</Popover.Dropdown>
    </Popover>
  );
}
