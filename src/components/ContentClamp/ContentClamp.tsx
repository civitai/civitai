import { MantineSize, Spoiler, SpoilerProps, Text } from '@mantine/core';

export function ContentClamp({ children, maxHeight = 200, labelSize = 'sm', ...props }: Props) {
  return (
    <Spoiler
      showLabel={<Text size={labelSize}>Show More</Text>}
      hideLabel={<Text size={labelSize}>Show More</Text>}
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
};
