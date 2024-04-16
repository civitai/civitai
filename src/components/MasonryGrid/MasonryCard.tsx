import { Card, CardProps, createPolymorphicComponent, useMantineTheme } from '@mantine/core';
import { forwardRef } from 'react';
import { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import { DecorationFrame } from '~/components/Decorations/DecorationFrame';

type MasonryCardProps = CardProps & {
  height?: number;
  uniform?: boolean;
  frameDecoration?: ContentDecorationCosmetic | null;
};
// TODO - when children not in view, replace child react nodes with static html
const _MasonryCard = forwardRef<HTMLDivElement, MasonryCardProps>(
  ({ height, children, style, uniform, frameDecoration, ...props }, ref) => {
    const theme = useMantineTheme();

    return (
      <div style={{ position: 'relative' }}>
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
        {frameDecoration && <DecorationFrame decoration={frameDecoration} />}
      </div>
    );
  }
);
_MasonryCard.displayName = 'MasonryCard';

export const MasonryCard = createPolymorphicComponent<'div', MasonryCardProps>(_MasonryCard);
