import { MantineSize, Spoiler, SpoilerProps, Text } from '@mantine/core';

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
      sx={(theme) => ({ fontSize: theme.fontSizes.sm })}
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
