import { ImageMetaProps } from '~/server/schema/image.schema';
import {
  Stack,
  Text,
  Code,
  Popover,
  PopoverProps,
  Group,
  SimpleGrid,
  Button,
  Badge,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconCheck, IconCopy } from '@tabler/icons';
import { useMemo } from 'react';
import { encodeMetadata } from '~/utils/image-metadata';
import { ImageGenerationProcess } from '@prisma/client';

type Props = {
  meta: ImageMetaProps;
  generationProcess?: ImageGenerationProcess;
};
type MetaDisplay = {
  label: string;
  value: string;
};

const labelDictionary: Record<keyof ImageMetaProps, string> = {
  prompt: 'Prompt',
  negativePrompt: 'Negative prompt',
  cfgScale: 'CFG scale',
  steps: 'Steps',
  sampler: 'Sampler',
  seed: 'Seed',
  Model: 'Model',
};

export function ImageMeta({ meta, generationProcess = 'txt2img' }: Props) {
  const { copied, copy } = useClipboard();
  // TODO only show keys in our meta list
  const metas = useMemo(() => {
    const long: MetaDisplay[] = [];
    const short: MetaDisplay[] = [];
    const medium: MetaDisplay[] = [];
    for (const key of Object.keys(labelDictionary)) {
      const value = meta[key]?.toString();
      if (!value) continue;
      const label = labelDictionary[key];
      if (value.length > 30 || key === 'prompt') long.push({ label, value });
      else if (value.length > 14) medium.push({ label, value });
      else short.push({ label, value });
    }
    return { long, medium, short };
  }, [meta]);

  return (
    <Stack spacing="xs">
      {metas.long.map(({ label, value }) => (
        <Stack key={label} spacing={0}>
          <Group spacing={4} align="center">
            <Text size="sm" weight={500}>
              {label}
            </Text>
            {label === 'Prompt' && (
              <Badge size="xs" radius="sm">
                {generationProcess === 'txt2imgHiRes' ? 'txt2img + Hi-Res' : generationProcess}
              </Badge>
            )}
          </Group>
          <Code block sx={{ whiteSpace: 'normal', maxHeight: 150, overflowY: 'auto' }}>
            {value}
          </Code>
        </Stack>
      ))}
      {metas.medium.map(({ label, value }) => (
        <Group key={label} position="apart">
          <Text size="sm" mr="xs" weight={500}>
            {label}
          </Text>
          <Code sx={{ flex: '1', textAlign: 'right', overflow: 'hidden', whiteSpace: 'nowrap' }}>
            {value}
          </Code>
        </Group>
      ))}
      <SimpleGrid cols={2} verticalSpacing="xs">
        {metas.short.map(({ label, value }) => (
          <Group key={label} spacing="xs">
            <Text size="sm" mr="xs" weight={500}>
              {label}
            </Text>
            <Code sx={{ flex: '1', textAlign: 'right', overflow: 'hidden', whiteSpace: 'nowrap' }}>
              {value}
            </Code>
          </Group>
        ))}
      </SimpleGrid>
      <Button
        size="xs"
        color={copied ? 'teal' : 'blue'}
        variant="light"
        leftIcon={copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
        onClick={() => {
          copy(encodeMetadata(meta));
        }}
      >
        {copied ? 'Copied' : 'Copy Generation Data'}
      </Button>
    </Stack>
  );
}

export function ImageMetaPopover({
  meta,
  generationProcess,
  children,
  ...popoverProps
}: Props & { children: React.ReactElement } & PopoverProps) {
  return (
    <Popover width={350} shadow="md" position="top-end" withArrow withinPortal {...popoverProps}>
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown>
        <ImageMeta meta={meta} generationProcess={generationProcess} />
      </Popover.Dropdown>
    </Popover>
  );
}
