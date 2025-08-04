import type { ButtonProps } from '@mantine/core';
import { Button, Text } from '@mantine/core';
import { IconBrush } from '@tabler/icons-react';
import React from 'react';

import { useGenerationPanelStore } from '~/store/generation-panel.store';
// import { generationPanel } from '~/store/generation.store';

export function GenerateButtonBasic({ ...buttonProps }: Omit<ButtonProps, 'onClick' | 'children'>) {
  const onClickHandler = () => {
    useGenerationPanelStore.setState((state) => ({ opened: !state.opened }));
  };

  return (
    <Button
      variant="filled"
      className="overflow-visible"
      style={{ flex: 1 }}
      onClick={onClickHandler}
      classNames={{ label: 'flex gap-2 items-center' }}
      {...buttonProps}
    >
      <IconBrush size={20} />
      <Text inherit inline className="hide-mobile">
        Create
      </Text>
    </Button>
  );
}
