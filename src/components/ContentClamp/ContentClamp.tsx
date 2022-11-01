import { Spoiler, SpoilerProps } from '@mantine/core';

export function ContentClamp({ children, maxHeight = 200, ...props }: Props) {
  return (
    <Spoiler
      showLabel="Show More"
      hideLabel="Hide"
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
};
