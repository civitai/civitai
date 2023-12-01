import { Card, CardProps, createPolymorphicComponent, useMantineTheme } from '@mantine/core';
import { forwardRef } from 'react';

type MasonryCardProps = CardProps & { height?: number; uniform?: boolean; cardDecoration?: any };
// TODO - when children not in view, replace child react nodes with static html
const _MasonryCard = forwardRef<HTMLDivElement, MasonryCardProps>(
  ({ height, children, style, uniform, ...props }, ref) => {
    const theme = useMantineTheme();

    return (
      <Card
        ref={ref}
        style={{
          height,
          ...style,
        }}
        sx={{
          padding: '0 !important',
          color: 'white',
          borderRadius: theme.radius.md,
          cursor: 'pointer',
        }}
        {...props}
      >
        {children}
      </Card>
    );
  }
);
_MasonryCard.displayName = 'MasonryCard';

export const MasonryCard = createPolymorphicComponent<'div', MasonryCardProps>(_MasonryCard);
