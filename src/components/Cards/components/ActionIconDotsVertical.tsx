import type { ActionIconProps } from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons-react';
import { forwardRef } from 'react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export const ActionIconDotsVertical = forwardRef<
  HTMLButtonElement,
  Omit<ActionIconProps, 'children'> & { onClick?: React.MouseEventHandler }
>((props, ref) => {
  return (
    <LegacyActionIcon ref={ref} color="gray" variant="transparent" {...props}>
      <IconDotsVertical
        size={26}
        color="#fff"
        style={{ filter: 'drop-shadow(0 1px 2px rgb(0 0 0 / 0.7))' }}
      />
    </LegacyActionIcon>
  );
});

ActionIconDotsVertical.displayName = 'ActionIconDotsVertical';
