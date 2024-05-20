import { AspectRatio, Card, CardProps } from '@mantine/core';
import Link from 'next/link';
import React, { forwardRef } from 'react';
import { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import { useFrameStyles } from '~/components/Cards/Cards.styles';

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
    const { classes, cx } = useFrameStyles({
      frame: frameDecoration?.data.cssFrame,
      texture: frameDecoration?.data.texture,
    });

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

    if (href)
      card = (
        <Link href={href} passHref>
          {card}
        </Link>
      );

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
