import { Badge, Button, ButtonProps, Group, Text, Tooltip, useMantineTheme } from '@mantine/core';
import { IconBolt, IconBrush } from '@tabler/icons-react';
import React from 'react';
import { generationPanel, useGenerationStore } from '~/store/generation.store';
import { abbreviateNumber } from '~/utils/number-helpers';

export function GenerateButton({
  iconOnly,
  modelVersionId,
  mode = 'replace',
  children,
  generationPrice,
  onPurchase,
  onClick,
  epochNumber,
  ...buttonProps
}: Props) {
  const theme = useMantineTheme();
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
      <Group spacing={0}>
        <IconBolt style={{ fill: theme.colors.dark[9] }} color="dark.9" size={16} />{' '}
        <Text color="dark.9">{abbreviateNumber(generationPrice ?? 0, { decimals: 0 })}</Text>
      </Group>
    </Badge>
  );

  const opened = useGenerationStore((state) => state.opened);
  const onClickHandler = () => {
    if (generationPrice) {
      onPurchase?.();
      return;
    }
    if (mode === 'toggle' && opened) return generationPanel.close();

    modelVersionId
      ? generationPanel.open({
          type: 'modelVersion',
          id: modelVersionId,
          epochNumbers: epochNumber ? [`${modelVersionId}@${epochNumber}`] : undefined,
        })
      : generationPanel.open();

    onClick?.();
  };

  if (children)
    return React.cloneElement(children, {
      ...buttonProps,
      onClick: onClickHandler,
      style: { cursor: 'pointer' },
    });

  const button = (
    <Button
      variant="filled"
      sx={iconOnly ? { paddingRight: 0, paddingLeft: 0, width: 36 } : { flex: 1 }}
      onClick={onClickHandler}
      {...buttonProps}
    >
      {generationPrice && <>{purchaseIcon}</>}
      {iconOnly ? (
        <IconBrush size={24} />
      ) : (
        <Group spacing={8} noWrap>
          <IconBrush size={20} />
          <Text inherit inline className="hide-mobile">
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
  modelVersionId?: number;
  mode?: 'toggle' | 'replace';
  children?: React.ReactElement;
  generationPrice?: number;
  onPurchase?: () => void;
  onClick?: () => void;
  epochNumber?: number;
};
