import { Popover, ThemeIcon } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { startCase } from 'lodash-es';

import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { ModelHash } from '~/components/Model/ModelHash/ModelHash';
import { ModelById } from '~/types/router';
import { formatKBytes } from '~/utils/number-helpers';

export function FileInfo({ file }: Props) {
  if (!file.hashes || !file.hashes.length) return null;

  const items = [
    { label: 'Hashes', value: <ModelHash hashes={file.hashes} /> },
    { label: 'File Size', value: formatKBytes(file.sizeKB) },
  ];
  if (file.metadata?.fp) items.push({ label: 'Floating Point', value: file.metadata.fp });
  if (file.metadata?.size)
    items.push({ label: 'Model Size', value: startCase(file.metadata.size) });

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
      <Popover.Dropdown p={0}>
        <DescriptionTable items={items}></DescriptionTable>
      </Popover.Dropdown>
    </Popover>
  );
}

type Props = { file: ModelById['modelVersions'][number]['files'][number] };
