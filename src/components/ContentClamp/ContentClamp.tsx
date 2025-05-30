import type { MantineSize, SpoilerProps } from '@mantine/core';
import { Spoiler, Text } from '@mantine/core';

export function ContentClamp({
  children,
  maxHeight = 200,
  labelSize = 'sm',
  label,
  ...props
}: Props) {
  return (
    <Spoiler
      showLabel={<Text size={labelSize}>{label ?? 'Show More'}</Text>}
      hideLabel={<Text size={labelSize}>Hide</Text>}
      maxHeight={maxHeight}
      className="text-sm"
      {...props}
    >
      {children}
    </Spoiler>
  );
}

type Props = Omit<SpoilerProps, 'showLabel' | 'hideLabel' | 'maxHeight'> & {
  maxHeight?: number;
  labelSize?: MantineSize;
  label?: string;
};
