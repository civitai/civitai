import { ImageMetaProps } from '~/server/schema/image.schema';
import { Stack, Text, Code, Popover, PopoverProps, Group, SimpleGrid, Button } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconCheck, IconCopy } from '@tabler/icons';
import { useMemo } from 'react';
import { encodeMetadata } from '~/utils/image-metadata';

type Props = {
  meta: ImageMetaProps;
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
};

export function ImageMeta({ meta }: Props) {
  const { copied, copy } = useClipboard();
  // TODO only show keys in our meta list
  const metas = useMemo(() => {
    const long: MetaDisplay[] = [];
    const short: MetaDisplay[] = [];
    for (const key of Object.keys(labelDictionary)) {
      const value = meta[key]?.toString();
      if (!value) continue;
      (value.length > 15 ? long : short).push({
        label: labelDictionary[key],
        value,
      });
    }
    return { long, short };
  }, [meta]);

  return (
    <Stack spacing="xs">
      {metas.long.map(({ label, value }) => (
        <Stack key={label} spacing={0}>
          <Text size="sm" weight={500}>
            {label}
          </Text>
          <Code block sx={{ whiteSpace: 'normal' }}>
            {value}
          </Code>
        </Stack>
      ))}
      <SimpleGrid cols={2} verticalSpacing="xs">
        {metas.short.map(({ label, value }) => (
          <Group key={label} spacing={0}>
            <Text size="sm" mr="xs" weight={500}>
              {label}
            </Text>
            <Code sx={{ flex: '1', textAlign: 'right' }}>{value}</Code>
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
  children,
  ...popoverProps
}: Props & { children: React.ReactElement } & PopoverProps) {
  return (
    <Popover width={350} shadow="md" position="top-end" withArrow withinPortal {...popoverProps}>
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown>
        <ImageMeta meta={meta} />
      </Popover.Dropdown>
    </Popover>
  );
}
