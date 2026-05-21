import type { ButtonProps } from '@mantine/core';
import { Badge, Button, Group, Text, Tooltip, useMantineTheme } from '@mantine/core';
import { IconBolt, IconBrush } from '@tabler/icons-react';
import React from 'react';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { abbreviateNumber } from '~/utils/number-helpers';

export function GenerateButton({
  iconOnly,
  mode = 'replace',
  children,
  generationPrice,
  onPurchase,
  onClick,
  epochNumber,
  versionId,
  wildcardSetId,
  ...buttonProps
}: Props) {
  const theme = useMantineTheme();

  const opened = useGenerationPanelStore((state) => state.opened);
  const onClickHandler = () => {
    if (generationPrice) {
      onPurchase?.();
      return;
    }
    if (mode === 'toggle' && opened) return generationGraphPanel.close();

    // Wildcards-type versions: short-circuit straight to the snippets node
    // — no `getGenerationData` round-trip required, since a wildcard set
    // doesn't need enriched resource data on the form side.
    if (wildcardSetId != null) {
      generationGraphPanel.open({ type: 'wildcard', wildcardSetId });
    } else if (versionId != null) {
      generationGraphPanel.open({ type: 'modelVersion', id: versionId, epoch: epochNumber });
    } else {
      generationGraphPanel.open();
    }

    onClick?.();
  };

  if (children)
    return React.cloneElement(children, {
      ...buttonProps,
      onClick: onClickHandler,
      style: { cursor: 'pointer' },
    });

  const purchaseIcon = (
    <Badge
      radius="sm"
      size="sm"
      variant="filled"
      color="yellow.7"
      style={{
        position: 'absolute',
        top: '-8px',
        right: '-8px',
        boxShadow: theme.shadows.sm,
        padding: '4px 2px',
        paddingRight: '6px',
      }}
    >
      <Group gap={0} wrap="nowrap">
        <IconBolt style={{ fill: theme.colors.dark[9] }} color="dark.9" size={14} />{' '}
        <Text size="xs" fz={11} c="dark.9">
          {abbreviateNumber(generationPrice ?? 0, { decimals: 0 })}
        </Text>
      </Group>
    </Badge>
  );

  const button = (
    <Button
      variant="filled"
      className="overflow-visible"
      {...buttonProps}
      onClick={onClickHandler}
      style={
        iconOnly
          ? { paddingRight: 0, paddingLeft: 0, width: 36, ...buttonProps.style }
          : {
              flex: 1,
              padding: '12px 20px',
              background:
                'linear-gradient(135deg, var(--mantine-color-blue-6), var(--mantine-color-blue-7))',
              ...buttonProps.style,
            }
      }
    >
      {generationPrice && <>{purchaseIcon}</>}
      {iconOnly ? (
        <IconBrush size={24} />
      ) : (
        <Group gap={8} wrap="nowrap">
          <IconBrush size={20} />
          <Text inherit inline fw={600} className="hide-mobile">
            Create
          </Text>
        </Group>
      )}
    </Button>
  );

  return iconOnly ? (
    <Tooltip label="Start Generating" withArrow>
      {button}
    </Tooltip>
  ) : (
    button
  );
}

type Props = Omit<ButtonProps, 'onClick' | 'children'> & {
  iconOnly?: boolean;
  mode?: 'toggle' | 'replace';
  children?: React.ReactElement;
  generationPrice?: number;
  onPurchase?: () => void;
  onClick?: () => void;
  epochNumber?: number;
  versionId?: number;
  /**
   * When set, the button opens the panel directly with this wildcard set
   * id loaded into the snippets node. Takes precedence over `versionId`.
   * Use for Wildcards-type model versions, where `model.getById` /
   * `modelVersion.getById` stamps `wildcardSetId` on the version response.
   */
  wildcardSetId?: number;
};
