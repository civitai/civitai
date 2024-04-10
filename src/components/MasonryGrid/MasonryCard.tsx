import { Card, CardProps, createPolymorphicComponent, useMantineTheme } from '@mantine/core';
import { forwardRef } from 'react';
import { BadgeCosmetic } from '~/server/selectors/cosmetic.selector';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';

type MasonryCardProps = CardProps & {
  height?: number;
  uniform?: boolean;
  frameDecoration?: BadgeCosmetic | null;
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
        {frameDecoration && frameDecoration.data.url && (
          <EdgeMedia
            src={frameDecoration.data.url}
            type="image"
            name="card decoration"
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%,-50%)',
              width: '100%',
              height: '100%',
              zIndex: 2,
              pointerEvents: 'none',
            }}
            width="original"
          />
        )}
      </div>
    );
  }
);
_MasonryCard.displayName = 'MasonryCard';

export const MasonryCard = createPolymorphicComponent<'div', MasonryCardProps>(_MasonryCard);
