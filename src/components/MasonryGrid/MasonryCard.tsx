import { Card, CardProps, createPolymorphicComponent, createStyles } from '@mantine/core';
import { forwardRef } from 'react';
import { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import { DecorationFrame } from '~/components/Decorations/DecorationFrame';

type MasonryCardProps = CardProps & {
  height?: number;
  uniform?: boolean;
  frameDecoration?: ContentDecorationCosmetic | null;
};

const useStyles = createStyles<string, { frame?: string }>((theme, params) => {
  const framePadding = 5;

  return {
    root: {
      padding: '0 !important',
      color: 'white',
      borderRadius: theme.radius.md,
      cursor: 'pointer',
      position: 'relative',
      overflow: 'hidden',
      backgroundColor: params.frame ? 'transparent' : undefined,
      margin: params.frame ? -framePadding : undefined,
    },

    frame: {
      backgroundImage: params.frame,
      borderRadius: theme.radius.md,
      zIndex: 1,
      padding: framePadding,
      position: 'relative',
    },

    glow: {
      '&:before': {
        backgroundImage: params.frame,
        content: '""',
        width: '100%',
        height: '100%',
        zIndex: -1,
        filter: 'blur(10px)',
        position: 'absolute',
        top: 0,
        left: 0,
      },
    },
  };
});

// TODO - when children not in view, replace child react nodes with static html
const _MasonryCard = forwardRef<HTMLDivElement, MasonryCardProps>(
  ({ height, children, style, uniform, frameDecoration, className, ...props }, ref) => {
    const { classes, cx } = useStyles({ frame: frameDecoration?.data.cssFrame });

    return (
      <div
        ref={ref}
        className={
          frameDecoration
            ? cx(
                frameDecoration.data.cssFrame && classes.frame,
                frameDecoration.data.glow && classes.glow
              )
            : undefined
        }
      >
        <Card style={{ height, ...style }} className={cx(classes.root, className)} {...props}>
          {children}
        </Card>
        {/* {frameDecoration && <DecorationFrame decoration={frameDecoration} />} */}
      </div>
    );
  }
);
_MasonryCard.displayName = 'MasonryCard';

export const MasonryCard = createPolymorphicComponent<'div', MasonryCardProps>(_MasonryCard);
