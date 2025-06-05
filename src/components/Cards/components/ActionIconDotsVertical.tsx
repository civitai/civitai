import type { ActionIconProps } from '@mantine/core';
import { ActionIcon } from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons-react';
import { forwardRef } from 'react';

export const ActionIconDotsVertical = forwardRef<
  HTMLButtonElement,
  Omit<ActionIconProps, 'children'> & { onClick?: React.MouseEventHandler }
>((props, ref) => {
  return (
    <ActionIcon ref={ref} variant="transparent" {...props}>
      <IconDotsVertical
        size={26}
        color="#fff"
        filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
      />
    </ActionIcon>
  );
});

ActionIconDotsVertical.displayName = 'ActionIconDotsVertical';
