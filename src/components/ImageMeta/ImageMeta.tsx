import { ComfyMetaSchema, ImageMetaProps } from '~/server/schema/image.schema';
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
  CopyButton,
  Tooltip,
  ActionIcon,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconCheck, IconCopy, IconBrush } from '@tabler/icons-react';
import { cloneElement, useMemo, useState } from 'react';
import { ImageGenerationProcess, ModelType } from '@prisma/client';
import { trpc } from '~/utils/trpc';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { generationPanel } from '~/store/generation.store';
import { encodeMetadata } from '~/utils/metadata';
import { fromJson } from '~/utils/json-helpers';

type Props = {
  meta: ImageMetaProps;
  generationProcess?: ImageGenerationProcess;
  imageId?: number;
  onCreateClick?: () => void;
  mainResourceId?: number;
  hideSoftware?: boolean;
};
type MetaDisplay = {
  label: string;
  value: React.ReactNode;
};

const labelDictionary: Record<keyof ImageMetaProps, string> = {
  prompt: 'Prompt',
  negativePrompt: 'Negative prompt',
  cfgScale: 'CFG scale',
  steps: 'Steps',
  sampler: 'Sampler',
  seed: 'Seed',
  Model: 'Model',
  'Clip skip': 'Clip skip',
  clipSkip: 'Clip skip',
  scheduler: 'Scheduler',
};

export function ImageMeta({
  meta,
  imageId,
  generationProcess = 'txt2img',
  mainResourceId,
  onCreateClick,
  hideSoftware,
}: Props) {
  const flags = useFeatureFlags();

  const metas = useMemo(() => {
    const long: MetaDisplay[] = [];
    const short: MetaDisplay[] = [];
    const medium: MetaDisplay[] = [];
    for (const key of Object.keys(labelDictionary)) {
      const value = meta[key]?.toString();
      if (value === undefined || value === null) continue;
      const label = labelDictionary[key];
      if (value.length > 30 || key === 'prompt') long.push({ label, value });
      else if (
        value.length > 14 ||
        key === 'Model' ||
        (key === 'negativePrompt' && value.length > 0)
      )
        medium.push({ label, value });
      else short.push({ label, value });
    }

    let hasControlNet = Object.keys(meta).some((x) => x.startsWith('ControlNet'));
    if (meta.comfy) {
      // @ts-ignore: ignoring because ts is acting up with meta.comfy not being defined
      medium.push({ label: 'Workflow', value: <ComfyNodes meta={meta} /> });
      hasControlNet = (meta.controlNets as string[])?.length > 0;
    }

    const onSite = 'civitaiResources' in meta;
    const software =
      meta.software?.toString() ?? (onSite ? 'Civitai Generator' : 'External Generator');

    return { long, medium, short, hasControlNet, onSite, software };
  }, [meta]);

  // TODO.optimize - can we get this data higher up?
  const { data = [] } = trpc.image.getResources.useQuery(
    { id: imageId as number },
    { enabled: flags.imageGeneration && !!imageId, trpc: { context: { skipBatch: true } } }
  );
  const resourceId =
    mainResourceId ?? data.find((x) => x.modelType === ModelType.Checkpoint)?.modelVersionId;

  const { data: resourceCoverage } = trpc.generation.checkResourcesCoverage.useQuery(
    { id: resourceId as number },
    { enabled: flags.imageGeneration && !!resourceId, trpc: { context: { skipBatch: true } } }
  );

  const canCreate = flags.imageGeneration && !!resourceCoverage && !!meta.prompt;

  return (
    <Stack spacing="xs">
      {metas.long.map(({ label, value }) => (
        <Stack key={label} spacing={0}>
          <Group spacing={4} align="center">
            <Text size="sm" weight={500}>
              {label}
            </Text>

            {label === 'Prompt' && (
              <>
                {!hideSoftware && (
                  <Badge size="xs" radius="sm">
                    {metas.software}
                  </Badge>
                )}
                <Badge size="xs" radius="sm">
                  {meta.comfy
                    ? 'Comfy'
                    : generationProcess === 'txt2imgHiRes'
                    ? 'txt2img + Hi-Res'
                    : generationProcess}
                  {metas.hasControlNet && ' + ControlNet'}
                </Badge>
              </>
            )}
            {(label === 'Prompt' || label === 'Negative prompt') && (
              <CopyButton value={value as string}>
                {({ copied, copy }) => (
                  <Tooltip label={`Copy ${label.toLowerCase()}`} color="dark" withArrow>
                    <ActionIcon
                      variant="transparent"
                      size="xs"
                      color={copied ? 'green' : 'blue'}
                      onClick={copy}
                      ml="auto"
                      data-activity="copy:prompt"
                    >
                      {!copied ? <IconCopy size={16} /> : <IconCheck size={16} />}
                    </ActionIcon>
                  </Tooltip>
                )}
              </CopyButton>
            )}
          </Group>
          <Code
            block
            sx={{
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
              maxHeight: 150,
              overflowY: 'auto',
            }}
          >
            {value}
          </Code>
        </Stack>
      ))}
      {metas.medium.map(({ label, value }) => (
        <Group key={label} position="apart">
          <Text size="sm" mr="xs" weight={500}>
            {label}
          </Text>
          <Code sx={{ flex: '1', textAlign: 'right', overflow: 'hidden', whiteSpace: 'pre-wrap' }}>
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
            <Code
              sx={{
                flex: '1',
                textAlign: 'right',
                overflow: 'hidden',
                whiteSpace: 'pre-wrap',
                maxWidth: 300,
              }}
            >
              {value}
            </Code>
          </Group>
        ))}
      </SimpleGrid>
      <Button.Group>
        {canCreate && (
          <Button
            size="xs"
            variant="light"
            leftIcon={<IconBrush size={16} />}
            data-activity="remix:image-meta"
            onClick={() => {
              generationPanel.open({ type: 'image', id: imageId ?? 0 });
              onCreateClick?.();
            }}
            sx={{ flex: 1 }}
          >
            Remix
          </Button>
        )}
        <GenerationDataButton meta={meta} iconOnly={canCreate} />
      </Button.Group>
    </Stack>
  );
}

function ComfyNodes({ meta }: { meta: ImageMetaProps }) {
  const { copied, copy } = useClipboard();
  const comfy = typeof meta.comfy === 'string' ? fromJson<ComfyMetaSchema>(meta.comfy) : meta.comfy;
  const { workflow } = comfy ?? {};

  return (
    <Group
      onClick={() => copy(JSON.stringify(workflow))}
      spacing={4}
      sx={{ justifyContent: 'flex-end', cursor: 'pointer' }}
      data-activity="copy:workflow"
    >
      {workflow?.nodes?.length ?? 0} Nodes
      {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
    </Group>
  );
}

function GenerationDataButton({
  meta,
  iconOnly = false,
}: {
  meta: ImageMetaProps;
  iconOnly?: boolean;
}) {
  const { copied, copy } = useClipboard();
  const label = copied ? 'Copied' : 'Copy Generation Data';
  const button = (
    <Button
      size="xs"
      color={copied ? 'teal' : 'blue'}
      variant="light"
      onClick={() => {
        copy(encodeMetadata(meta));
      }}
      w={!iconOnly ? '100%' : undefined}
      data-activity="copy:image-meta"
    >
      <Group spacing={4}>
        {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
        {!iconOnly && label}
      </Group>
    </Button>
  );

  if (!iconOnly) return button;
  return (
    <Tooltip label={label} color="dark" withArrow withinPortal>
      {button}
    </Tooltip>
  );
}

export function ImageMetaPopover({
  meta,
  generationProcess,
  children,
  imageId,
  mainResourceId,
  hideSoftware = false,
  ...popoverProps
}: Props & { children: React.ReactElement } & PopoverProps) {
  const [opened, setOpened] = useState(false);

  return (
    <div
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Popover
        width={350}
        shadow="md"
        position="top-end"
        withArrow
        withinPortal
        opened={opened}
        onChange={(opened) => setOpened(opened)}
        {...popoverProps}
      >
        <Popover.Target>
          {cloneElement(children, { onClick: () => setOpened((o) => !o) })}
        </Popover.Target>
        <Popover.Dropdown>
          <ImageMeta
            meta={meta}
            generationProcess={generationProcess}
            imageId={imageId}
            mainResourceId={mainResourceId}
            hideSoftware={hideSoftware}
            onCreateClick={() => setOpened(false)}
          />
        </Popover.Dropdown>
      </Popover>
    </div>
  );
}
