import { ActionIcon, Code, Group, Popover, Stack, Text, Tooltip } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { ModelType } from '@prisma/client';
import { IconCheck, IconCopy, IconInfoSquareRounded } from '@tabler/icons-react';
import { useMemo } from 'react';
import { BaseModel, baseModelSets } from '~/server/common/constants';

const typeUrnMap: Partial<Record<ModelType, string>> = {
  [ModelType.AestheticGradient]: 'ag',
  [ModelType.Checkpoint]: 'checkpoint',
  [ModelType.Hypernetwork]: 'hypernet',
  [ModelType.TextualInversion]: 'embedding',
  [ModelType.MotionModule]: 'motion',
  [ModelType.Upscaler]: 'upscaler',
  [ModelType.VAE]: 'vae',
  [ModelType.LORA]: 'lora',
  [ModelType.LoCon]: 'lycoris',
  [ModelType.Controlnet]: 'controlnet',
};

export const ModelURN = ({ baseModel, type, modelId, modelVersionId, full = false }: Props) => {
  const { copied, copy } = useClipboard();
  const urnType = typeUrnMap[type];
  const urnEcosystem = useMemo(() => {
    return (
      Object.entries(baseModelSets).find(([value]) => value.includes(baseModel))?.[0] ?? 'sd1'
    ).toLowerCase();
  }, [baseModel]);
  if (!urnType) return null;

  const shortUrn = `${modelId}@${modelVersionId}`;
  const urn = `urn:air:${urnEcosystem}:${urnType}:civitai:${shortUrn}`;

  return (
    <Group spacing={4}>
      <Group
        spacing={0}
        sx={{
          code: {
            borderRadius: 0,
            lineHeight: 1.2,
            paddingLeft: 4,
            paddingRight: 4,
            cursor: 'pointer',
          },
        }}
      >
        {full ? (
          <Code>
            urn:air:{urnEcosystem}:{urnType}:civitai:
          </Code>
        ) : (
          <Code>civitai:</Code>
        )}
        <CopyTooltip copied={copied} label="Model ID">
          <Code color="blue" onClick={() => copy(modelId)}>
            {modelId}
          </Code>
        </CopyTooltip>
        <Code>@</Code>
        <CopyTooltip copied={copied} label=" Version ID">
          <Code color="blue" onClick={() => copy(modelVersionId)}>
            {modelVersionId}
          </Code>
        </CopyTooltip>
      </Group>
      <ActionIcon
        size="xs"
        onClick={(e) => {
          e.stopPropagation();
          copy(full ? urn : shortUrn);
        }}
      >
        {copied ? <IconCheck size="20" /> : <IconCopy size="20" />}
      </ActionIcon>
    </Group>
  );
};

const CopyTooltip = ({
  copied,
  children,
  label,
}: {
  copied: boolean;
  children: React.ReactNode;
  label?: React.ReactNode;
}) => (
  <Tooltip label={copied ? 'Copied' : label ?? 'Copy'} withArrow>
    {children}
  </Tooltip>
);

const urnParts = [
  { name: 'ecosystem', description: 'The resource ecosystem' },
  { name: 'type', description: 'The resource type' },
  { name: 'source', description: 'The resource source' },
  { name: 'id', description: 'The resource id at the source' },
];
export function URNExplanation({ size }: { size?: number }) {
  return (
    <Popover width={300} withArrow withinPortal shadow="sm">
      <Popover.Target>
        <IconInfoSquareRounded size={size ?? 16} style={{ cursor: 'pointer', opacity: 0.7 }} />
      </Popover.Target>
      <Popover.Dropdown>
        <Stack spacing="xs">
          <Text size="sm" weight={500}>
            What is an AIR?
          </Text>
          <Text size="xs" lh={1.3}>
            AIR stands for Artificial Intelligence Resource. It is a comprehensive unique
            identifier, and is composed of the following parts:
          </Text>
          <Stack spacing={4}>
            {urnParts.map(({ name, description }) => (
              <Text size="xs" key={name}>
                <Code color="blue">{name}</Code> {description}
              </Text>
            ))}
          </Stack>
          <Text size="xs" lh={1.3}>
            For brevity we have opted not to show the full AIR here. To learn more about AIRs,{' '}
            <Text
              component="a"
              variant="link"
              td="underline"
              href="/github/wiki/AIR-‐-Uniform-Resource-Names-for-AI"
              target="_blank"
            >
              Check out the specification
            </Text>
          </Text>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

type Props = {
  baseModel: BaseModel;
  type: ModelType;
  modelId: number;
  modelVersionId: number;
  full?: boolean;
};
