import { AspectRatio, Card, CardProps, createStyles } from '@mantine/core';
import Link from 'next/link';
import React, { forwardRef } from 'react';
import { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import { DecorationFrame } from '~/components/Decorations/DecorationFrame';
import { constants } from '~/server/common/constants';

type AspectRatio = 'portrait' | 'landscape' | 'square' | 'flat';
const aspectRatioValues: Record<
  AspectRatio,
  { ratio: number; height: number; cssRatio: number; stringRatio: string }
> = {
  portrait: {
    ratio: 7 / 9,
    height: 430,
    // CSS Ratio should be opposite to ratio as it will rely on width.
    cssRatio: 9 / 7,
    stringRatio: '7/9',
  },
  landscape: {
    ratio: 9 / 7,
    height: 300,
    cssRatio: 7 / 9,
    stringRatio: '9/7',
  },
  flat: {
    ratio: 15 / 7,
    height: 300,
    cssRatio: 7 / 15,
    stringRatio: '15/7',
  },
  square: {
    ratio: 1,
    height: 332,
    cssRatio: 1,
    stringRatio: '1',
  },
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
      // img: {
      //   display: 'none',
      // },
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

export const FeedCard = forwardRef<HTMLAnchorElement, Props>(
  (
    {
      href,
      children,
      aspectRatio = 'portrait',
      className,
      useCSSAspectRatio,
      frameDecoration,
      ...props
    },
    ref
  ) => {
    const { stringRatio } = aspectRatioValues[aspectRatio];
    const { classes, cx } = useStyles({ frame: frameDecoration?.data.cssFrame });

    let card = (
      <Card<'a'>
        className={cx(classes.root, className)}
        {...props}
        component={href ? 'a' : undefined}
        ref={ref}
        style={{ aspectRatio: stringRatio }}
      >
        {children}
      </Card>
    );

    if (href) card = <Link href={href}>{card}</Link>;

    if (frameDecoration) {
      card = (
        <div className={classes.glow}>
          <div className={cx('frame-decoration', classes.frame)}>{card}</div>
        </div>
      );
    }

    return card;
  }
);

FeedCard.displayName = 'FeedCard';

type Props = CardProps & {
  children: React.ReactNode;
  href?: string;
  aspectRatio?: AspectRatio;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  useCSSAspectRatio?: boolean;
  frameDecoration?: ContentDecorationCosmetic | null;
};
