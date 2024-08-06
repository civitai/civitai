import { Button, ButtonProps, Group, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { IconBolt, IconBrush } from '@tabler/icons-react';
import React from 'react';
import { generationPanel, useGenerationStore } from '~/store/generation.store';

export function GenerateButton({
  iconOnly,
  modelVersionId,
  mode = 'replace',
  children,
  generationRequiresPurchase,
  onPurchase,
  onClick,
  ...buttonProps
}: Props) {
  const purchaseIcon = (
    <ThemeIcon
      radius="xl"
      size="sm"
      color="yellow.7"
      style={{
        position: 'absolute',
        top: '-8px',
        right: '-8px',
      }}
    >
      <IconBolt size={16} />
    </ThemeIcon>
  );

  const opened = useGenerationStore((state) => state.opened);
  const onClickHandler = () => {
    if (generationRequiresPurchase) {
      onPurchase?.();
      return;
    }
    if (mode === 'toggle' && opened) return generationPanel.close();

    modelVersionId
      ? generationPanel.open({ type: 'modelVersion', id: modelVersionId })
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
      {generationRequiresPurchase && <>{purchaseIcon}</>}
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
  generationRequiresPurchase?: boolean;
  onPurchase?: () => void;
  onClick?: () => void;
};
