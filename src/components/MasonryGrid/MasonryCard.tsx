import { Card, CardProps, createPolymorphicComponent } from '@mantine/core';
import { forwardRef } from 'react';
import { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import { useFrameStyles } from '~/components/Cards/Cards.styles';

type MasonryCardProps = CardProps & {
  height?: number;
  uniform?: boolean;
  frameDecoration?: ContentDecorationCosmetic | null;
};

// TODO - when children not in view, replace child react nodes with static html
const _MasonryCard = forwardRef<HTMLDivElement, MasonryCardProps>(
  ({ height, children, style, uniform, frameDecoration, className, ...props }, ref) => {
    const { classes, cx } = useFrameStyles({
      frame: frameDecoration?.data.cssFrame,
      texture: frameDecoration?.data.texture,
    });

    return (
      <div ref={ref} className={frameDecoration ? classes.glow : undefined}>
        <div className={frameDecoration ? classes.frame : undefined}>
          <Card style={{ height, ...style }} className={cx(classes.root, className)} {...props}>
            {children}
          </Card>
        </div>
      </div>
    );
  }
);
_MasonryCard.displayName = 'MasonryCard';

export const MasonryCard = createPolymorphicComponent<'div', MasonryCardProps>(_MasonryCard);
