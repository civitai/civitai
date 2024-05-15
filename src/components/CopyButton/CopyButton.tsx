import { CopyButtonProps, MantineColor, CopyButton as MantineCopyButton } from '@mantine/core';
import { TablerIconsProps, IconCheck, IconCopy } from '@tabler/icons-react';

export function CopyButton({
  children,
  ...props
}: Omit<CopyButtonProps, 'children'> & {
  children(payload: {
    copied: boolean;
    copy(): void;
    Icon: (props: TablerIconsProps) => JSX.Element;
    color?: MantineColor;
  }): React.ReactNode;
}) {
  return (
    <MantineCopyButton {...props}>
      {({ copy, copied }) => {
        const Icon = copied ? IconCheck : IconCopy;
        const color = copied ? 'green' : undefined;
        return children({ copy, copied, Icon, color });
      }}
    </MantineCopyButton>
  );
}
