import { CopyButtonProps, MantineColor } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { IconProps, IconCheck, IconCopy, Icon } from '@tabler/icons-react';
import { ForwardRefExoticComponent, RefAttributes } from 'react';

export function CopyButton({
  children,
  value,
  timeout,
}: Omit<CopyButtonProps, 'children' | 'value'> & {
  children(payload: {
    copied: boolean;
    copy(): void;
    Icon: ForwardRefExoticComponent<IconProps & RefAttributes<Icon>>;
    color?: MantineColor;
  }): React.ReactElement;
  value: string | (() => string);
  timeout?: number;
}) {
  const { copy, copied } = useClipboard({ timeout });

  const handleCopy = () => {
    copy(typeof value === 'string' ? value : value());
  };

  const Icon = copied ? IconCheck : IconCopy;
  const color = copied ? 'teal' : undefined;
  return children({ copy: handleCopy, copied, Icon, color });
}
