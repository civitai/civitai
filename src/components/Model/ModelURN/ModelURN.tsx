import { ActionIcon, Badge, Code, CopyButton, Group, MantineColor, Tooltip } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { ModelType } from '@prisma/client';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useMemo } from 'react';
import { BaseModel, baseModelSets } from '~/server/common/constants';

const typeUrnMap: Partial<Record<ModelType, string>> = {
  [ModelType.AestheticGradient]: 'ag',
  [ModelType.Checkpoint]: 'checkpoint',
  [ModelType.Hypernetwork]: 'hypernet',
  [ModelType.TextualInversion]: 'embedding',
  [ModelType.Upscaler]: 'upscaler',
  [ModelType.VAE]: 'vae',
  [ModelType.LORA]: 'lora',
  [ModelType.LoCon]: 'lycoris',
  [ModelType.Controlnet]: 'controlnet',
};

export const ModelURN = ({ baseModel, type, modelId, modelVersionId }: Props) => {
  const { copied, copy } = useClipboard();
  const urnType = typeUrnMap[type];
  const urnEcosystem = useMemo(() => {
    return (
      Object.entries(baseModelSets).find(([value]) => value.includes(baseModel))?.[0] ?? 'sd1'
    ).toLowerCase();
  }, [baseModel]);
  if (!urnType) return null;

  const urn = `urn:air:${urnEcosystem}:${urnType}:civitai:${modelId}@${modelVersionId}`;

  return (
    <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow withinPortal>
      <Group spacing={4}>
        <Group
          spacing={0}
          sx={{
            code: {
              fontSize: 10,
              borderRadius: 0,
              lineHeight: 1.2,
              paddingLeft: 4,
              paddingRight: 4,
            },
          }}
        >
          <Code>
            urn:air:{urnEcosystem}:{urnType}:civitai:
          </Code>
          <Code color="blue" onClick={() => copy(modelId)}>
            {modelId}
          </Code>
          <Code>@</Code>
          <Code color="teal" onClick={() => copy(modelVersionId)}>
            {modelVersionId}
          </Code>
        </Group>
        <ActionIcon
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            copy(urn);
          }}
        >
          {copied ? <IconCheck size="20" /> : <IconCopy size="20" />}
        </ActionIcon>
      </Group>
    </Tooltip>
  );
};

type Props = {
  baseModel: BaseModel;
  type: ModelType;
  modelId: number;
  modelVersionId: number;
};
