import { Button, ButtonProps, Group, Text, Tooltip } from '@mantine/core';
import { IconBrush } from '@tabler/icons-react';
import React from 'react';
import { generationPanel, useGenerationStore } from '~/store/generation.store';

export function GenerateButton({
  iconOnly,
  modelVersionId,
  mode = 'replace',
  children,
  ...buttonProps
}: Props) {
  const opened = useGenerationStore((state) => state.opened);
  const onClickHandler = () => {
    if (mode === 'toggle' && opened) return generationPanel.close();

    modelVersionId
      ? generationPanel.open({ type: 'modelVersion', id: modelVersionId })
      : generationPanel.open();
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
};
