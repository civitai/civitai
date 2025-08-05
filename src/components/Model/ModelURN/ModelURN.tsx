import { ActionIcon, Code, Group, Popover, Stack, Text, Tooltip } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconCheck, IconCopy, IconInfoSquareRounded } from '@tabler/icons-react';
import { useMemo } from 'react';
import type { BaseModel } from '~/server/common/constants';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { stringifyAIR } from '~/shared/utils/air';
import classes from './ModelURN.module.scss';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export const ModelURN = ({ baseModel, type, modelId, modelVersionId, withCopy = true }: Props) => {
  const { copied, copy } = useClipboard();
  const urn = useMemo(
    () => stringifyAIR({ baseModel, type, modelId, id: modelVersionId }),
    [baseModel, type, modelId, modelVersionId]
  );
  if (!urn) return null;

  return (
    <Group gap={4}>
      <Group gap={0}>
        <Code className={classes.code}>civitai:</Code>

        {withCopy ? (
          <CopyTooltip copied={copied} label="Model ID">
            <Code className={classes.code} color="blue" onClick={() => copy(modelId)}>
              {modelId}
            </Code>
          </CopyTooltip>
        ) : (
          <Tooltip label="Model ID">
            <Code className={classes.code} color="blue">
              {modelId}
            </Code>
          </Tooltip>
        )}
        <Code className={classes.code}>@</Code>
        {withCopy ? (
          <CopyTooltip copied={copied} label="Version ID">
            <Code className={classes.code} color="blue" onClick={() => copy(modelVersionId)}>
              {modelVersionId}
            </Code>
          </CopyTooltip>
        ) : (
          <Tooltip label="Version ID">
            <Code className={classes.code} color="blue">
              {modelVersionId}
            </Code>
          </Tooltip>
        )}
      </Group>
      {withCopy && (
        <LegacyActionIcon
          size="xs"
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            copy(urn);
          }}
        >
          {copied ? <IconCheck size="20" /> : <IconCopy size="20" />}
        </LegacyActionIcon>
      )}
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
        <Stack gap="xs">
          <Text size="sm" fw={500}>
            What is an AIR?
          </Text>
          <Text size="xs" lh={1.3}>
            AIR stands for Artificial Intelligence Resource. It is a comprehensive unique
            identifier, and is composed of the following parts:
          </Text>
          <Stack gap={4}>
            {urnParts.map(({ name, description }) => (
              <Text size="xs" key={name}>
                <Code className={classes.code} color="blue">
                  {name}
                </Code>{' '}
                {description}
              </Text>
            ))}
          </Stack>
          <Text size="xs" lh={1.3}>
            For brevity we have opted not to show the full AIR here. To learn more about AIRs,{' '}
            <Text
              component="a"
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
  withCopy?: boolean;
};
