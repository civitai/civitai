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
  const framePadding = 6;

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
      position: 'relative',
      backgroundImage: `url("https://www.transparenttextures.com/patterns/brilliant.png"), ${params.frame}`,
      backgroundSize: '3px 3px, cover',
      borderRadius: theme.radius.md,
      zIndex: 2,
      padding: framePadding,
      boxShadow: 'inset 0 0 1px 1px rgba(255,255,255, 0.3), 0 1px 2px rgba(0, 0, 0, 0.8)',
    },

    glow: {
      position: 'relative',
      '&:before': {
        borderRadius: theme.radius.md,
        backgroundImage: params.frame,
        content: '""',
        width: '100%',
        height: '100%',
        zIndex: -1,
        filter: 'blur(5px)',
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
      <div ref={ref} className={frameDecoration ? classes.glow : undefined}>
        <div className={frameDecoration ? classes.frame : undefined}>
          <Card style={{ height, ...style }} className={cx(classes.root, className)} {...props}>
            {children}
          </Card>
        </div>
        {/* {frameDecoration && <DecorationFrame decoration={frameDecoration} />} */}
      </div>
    );
  }
);
_MasonryCard.displayName = 'MasonryCard';

export const MasonryCard = createPolymorphicComponent<'div', MasonryCardProps>(_MasonryCard);
