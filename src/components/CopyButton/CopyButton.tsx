import { CopyButtonProps, MantineColor } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { TablerIconsProps, IconCheck, IconCopy } from '@tabler/icons-react';

export function CopyButton({
  children,
  value,
  timeout,
}: Omit<CopyButtonProps, 'children' | 'value'> & {
  children(payload: {
    copied: boolean;
    copy(): void;
    Icon: (props: TablerIconsProps) => JSX.Element;
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
