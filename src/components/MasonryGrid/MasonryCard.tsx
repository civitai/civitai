import {
  Card,
  CardProps,
  createPolymorphicComponent,
  CSSObject,
  createStyles,
} from '@mantine/core';
import { forwardRef } from 'react';
import { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import { DecorationFrame } from '~/components/Decorations/DecorationFrame';

type MasonryCardProps = CardProps & {
  height?: number;
  uniform?: boolean;
  frameDecoration?: ContentDecorationCosmetic | null;
};

const useStyles = createStyles<string, { frame?: CSSObject; glow?: CSSObject }>((theme, params) => {
  return {
    root: {
      padding: '0 !important',
      color: 'white',
      borderRadius: theme.radius.md,
      cursor: 'pointer',
      position: 'relative',
      overflow: 'hidden',
    },

    frame: {
      ...params.frame,
      borderRadius: theme.radius.md,
      zIndex: 1,
      padding: 5,

      '&:before': { ...params.glow, content: '""', width: '100%', height: '100%', zIndex: -1 },
    },
  };
});

// TODO - when children not in view, replace child react nodes with static html
const _MasonryCard = forwardRef<HTMLDivElement, MasonryCardProps>(
  ({ height, children, style, uniform, frameDecoration, ...props }, ref) => {
    const { classes, cx } = useStyles({
      frame: frameDecoration?.data.cssFrame,
      glow: frameDecoration?.data.glow,
    });

    return (
      <div
        ref={ref}
        className={cx(frameDecoration && frameDecoration.data.cssFrame && classes.frame)}
        style={{ position: frameDecoration ? 'relative' : undefined }}
      >
        <Card
          style={{ height, ...style }}
          sx={(theme) => ({
            padding: '0 !important',
            color: 'white',
            borderRadius: theme.radius.md,
            cursor: 'pointer',
          })}
          {...props}
        >
          {children}
        </Card>
        {/* {frameDecoration && <DecorationFrame decoration={frameDecoration} />} */}
      </div>
    );
  }
);
_MasonryCard.displayName = 'MasonryCard';

export const MasonryCard = createPolymorphicComponent<'div', MasonryCardProps>(_MasonryCard);
