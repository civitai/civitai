import { Stack, Text, Code, Popover, PopoverProps, Title } from '@mantine/core';
import { ImageMetaProps } from '~/server/validators/image/schemas';

type Props = {
  meta: ImageMetaProps;
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
  const keys = Object.keys(labelDictionary) as Array<keyof ImageMetaProps>;
  return (
    <Stack spacing="xs">
      {keys
        .filter((key) => !!meta[key])
        .map((key) => (
          <Text key={key}>
            {labelDictionary[key]}: <Code>{meta[key]}</Code>
          </Text>
        ))}
    </Stack>
  );
}

export function ImageMetaPopover({
  meta,
  children,
  ...popoverProps
}: Props & { children: React.ReactElement } & PopoverProps) {
  return (
    <Popover
      width={350}
      shadow="md"
      position="bottom-start"
      withArrow
      withinPortal
      {...popoverProps}
    >
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown>
        <Stack>
          <Title order={4}>Metadata</Title>
          <ImageMeta meta={meta} />
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
