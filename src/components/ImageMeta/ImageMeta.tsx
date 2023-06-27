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
  CopyButton,
  Tooltip,
  ActionIcon,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconCheck, IconCopy, IconBrush } from '@tabler/icons-react';
import { useMemo } from 'react';
import { encodeMetadata } from '~/utils/image-metadata';
import { ImageGenerationProcess, ModelType } from '@prisma/client';
import { trpc } from '~/utils/trpc';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useGenerationStore } from '~/store/generation.store';

type Props = {
  meta: ImageMetaProps;
  generationProcess?: ImageGenerationProcess;
  imageId?: number;
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
  'Clip skip': 'Clip skip',
};

export function ImageMeta({ meta, imageId, generationProcess = 'txt2img' }: Props) {
  const flags = useFeatureFlags();
  const toggleGenerationDrawer = useGenerationStore((state) => state.toggleDrawer);

  const { copied, copy } = useClipboard();
  const metas = useMemo(() => {
    const long: MetaDisplay[] = [];
    const short: MetaDisplay[] = [];
    const medium: MetaDisplay[] = [];
    for (const key of Object.keys(labelDictionary)) {
      const value = meta[key]?.toString();
      if (!value) continue;
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
    const hasControlNet = Object.keys(meta).some((x) => x.startsWith('ControlNet'));
    return { long, medium, short, hasControlNet };
  }, [meta]);

  const { data = [] } = trpc.image.getResources.useQuery(
    { id: imageId as number },
    { enabled: flags.imageGeneration && !!imageId }
  );
  const resourceId = data.find((x) => x.modelType === ModelType.Checkpoint)?.modelVersionId;

  const { data: resourceCoverage } = trpc.generation.checkResourcesCoverage.useQuery(
    { id: resourceId as number },
    { enabled: flags.imageGeneration && !!resourceId }
  );

  return (
    <Stack spacing="xs">
      {/* <DismissibleAlert
        id="image-reproduction"
        title="What is this?"
        getInitialValueInEffect={false}
        content={
          <>
            This is the data used to generate this image.{' '}
            <Text component="span" weight={500} sx={{ lineHeight: 1.1 }}>
              The image may not be exactly the same when you generate it.
            </Text>{' '}
            <Text
              component="a"
              td="underline"
              variant="link"
              sx={{ lineHeight: 1.1 }}
              href="/github/wiki/Image-Reproduction"
              target="_blank"
            >
              Learn why...
            </Text>
          </>
        }
      /> */}
      {metas.long.map(({ label, value }) => (
        <Stack key={label} spacing={0}>
          <Group spacing={4} align="center">
            <Text size="sm" weight={500}>
              {label}
            </Text>

            {label === 'Prompt' && (
              <>
                <Badge size="xs" radius="sm">
                  {generationProcess === 'txt2imgHiRes' ? 'txt2img + Hi-Res' : generationProcess}
                  {metas.hasControlNet && ' + ControlNet'}
                </Badge>
              </>
            )}
            {(label === 'Prompt' || label === 'Negative prompt') && (
              <CopyButton value={value}>
                {({ copied, copy }) => (
                  <Tooltip label={`Copy ${label.toLowerCase()}`} color="dark" withArrow>
                    <ActionIcon
                      variant="transparent"
                      size="xs"
                      color={copied ? 'green' : 'blue'}
                      onClick={copy}
                      ml="auto"
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
              whiteSpace: 'normal',
              wordBreak: 'break-word',
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
            <Code
              sx={{
                flex: '1',
                textAlign: 'right',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                maxWidth: 300,
              }}
            >
              {value}
            </Code>
          </Group>
        ))}
      </SimpleGrid>
      {resourceCoverage ? (
        <Button.Group>
          <Button
            size="xs"
            color="teal"
            variant="light"
            leftIcon={<IconBrush size={16} />}
            // TODO.generation: Send generation data to the drawer
            onClick={toggleGenerationDrawer}
            sx={{ flex: 1 }}
          >
            Start Creating
          </Button>
          <Tooltip
            label={copied ? 'Copied' : 'Copy generation data'}
            color="gray"
            withArrow
            withinPortal
          >
            <Button
              size="xs"
              color="teal"
              variant="light"
              onClick={() => {
                copy(encodeMetadata(meta));
              }}
            >
              {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            </Button>
          </Tooltip>
        </Button.Group>
      ) : (
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
      )}
    </Stack>
  );
}

export function ImageMetaPopover({
  meta,
  generationProcess,
  children,
  imageId,
  ...popoverProps
}: Props & { children: React.ReactElement } & PopoverProps) {
  return (
    <div
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Popover width={350} shadow="md" position="top-end" withArrow withinPortal {...popoverProps}>
        <Popover.Target>{children}</Popover.Target>
        <Popover.Dropdown>
          <ImageMeta meta={meta} generationProcess={generationProcess} imageId={imageId} />
        </Popover.Dropdown>
      </Popover>
    </div>
  );
}
