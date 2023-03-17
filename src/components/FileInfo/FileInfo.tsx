import { Popover, ThemeIcon } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons';

import { ModelHash } from '~/components/Model/ModelHash/ModelHash';
import { ModelById } from '~/types/router';

export function FileInfo({ file }: Props) {
  if (!file.hashes || !file.hashes.length) return null;

  return (
    <Popover withinPortal withArrow>
      <Popover.Target>
        <ThemeIcon
          variant="light"
          size="xs"
          radius="xl"
          color="gray"
          sx={{ cursor: 'pointer' }}
          onClick={(e) => e.stopPropagation()}
        >
          <IconInfoCircle />
        </ThemeIcon>
      </Popover.Target>
      <Popover.Dropdown>
        <ModelHash hashes={file.hashes} />
      </Popover.Dropdown>
    </Popover>
  );
}

type Props = { file: ModelById['modelVersions'][number]['files'][number] };
