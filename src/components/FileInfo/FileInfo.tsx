import { Popover, ThemeIcon } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { startCase } from 'lodash-es';

import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { ModelHash } from '~/components/Model/ModelHash/ModelHash';
import type { ModelById } from '~/types/router';
import { formatKBytes } from '~/utils/number-helpers';

// Component type display names for user-friendly labels
const componentTypeDisplayNames: Record<ModelFileComponentType, string> = {
  VAE: 'VAE',
  TextEncoder: 'Text Encoder',
  UNet: 'UNet',
  CLIPVision: 'CLIP Vision',
  ControlNet: 'ControlNet',
  Config: 'Config',
  Other: 'Other',
};

export function FileInfo({ file }: Props) {
  if (!file.hashes || !file.hashes.length) return null;

  const isGGUF = file.name?.toLowerCase().endsWith('.gguf');
  const isComponentFile = file.type && !['Model', 'Pruned Model'].includes(file.type as string);

  const items = [
    { label: 'Hashes', value: <ModelHash hashes={file.hashes} /> },
    { label: 'File Size', value: formatKBytes(file.sizeKB) },
  ];
  if (file.metadata?.fp) items.push({ label: 'Precision', value: file.metadata.fp });
  if (file.metadata?.format && file.name?.toLowerCase().endsWith('.zip'))
    items.push({ label: 'Format', value: file.metadata.format });
  if (file.metadata?.size)
    items.push({ label: 'Model Size', value: startCase(file.metadata.size) });
  // Show quantType for GGUF files
  if (isGGUF && file.metadata?.quantType)
    items.push({ label: 'Quant Type', value: file.metadata.quantType });
  // Show componentType for component files
  if (isComponentFile && file.metadata?.componentType) {
    const componentType = file.metadata.componentType as ModelFileComponentType;
    items.push({
      label: 'Component Type',
      value: componentTypeDisplayNames[componentType] ?? file.metadata.componentType,
    });
  }

  return (
    <Popover withinPortal withArrow>
      <Popover.Target>
        <ThemeIcon
          variant="light"
          size="xs"
          radius="xl"
          color="gray"
          style={{ cursor: 'pointer' }}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
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
