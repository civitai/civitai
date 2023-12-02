import { AspectRatio, Card, CardProps, createStyles } from '@mantine/core';
import Link from 'next/link';
import React, { forwardRef } from 'react';

type AspectRatio = 'portrait' | 'landscape' | 'square' | 'flat';
const aspectRatioValues: Record<AspectRatio, { ratio: number; height: number; cssRatio: number }> =
  {
    portrait: {
      ratio: 7 / 9,
      height: 430,
      // CSS Ratio should be opposite to ratio as it will rely on width.
      cssRatio: 9 / 7,
    },
    landscape: {
      ratio: 9 / 7,
      height: 300,
      cssRatio: 7 / 9,
    },
    flat: {
      ratio: 15 / 7,
      height: 300,
      cssRatio: 7 / 15,
    },
    square: {
      ratio: 1,
      height: 332,
      cssRatio: 1,
    },
  };

const useStyles = createStyles<string, { aspectRatio?: number }>((theme, { aspectRatio }) => {
  return {
    root: {
      padding: '0 !important',
      color: 'white',
      borderRadius: theme.radius.md,
      cursor: 'pointer',
      ...(aspectRatio
        ? {
            position: 'relative',
            height: 0,
            paddingBottom: `${(aspectRatio * 100).toFixed(3)}% !important`,
            overflow: 'hidden',
          }
        : {}),
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
      cardDecoration,
      inViewOptions,
      ...props
    },
    ref
  ) => {
    const { ratio, cssRatio } = aspectRatioValues[aspectRatio];
    const { classes, cx } = useStyles({ aspectRatio: useCSSAspectRatio ? cssRatio : undefined });

    // const {ref, inView} = useInView(inViewOptions)

    const card = (
      <Card<'a'>
        className={cx(classes.root, className)}
        {...props}
        component={href ? 'a' : undefined}
        ref={ref}
      >
        <AspectRatio ratio={ratio} w="100%">
          {children}
        </AspectRatio>
      </Card>
    );

    return href ? (
      <Link href={href} passHref>
        {card}
      </Link>
    ) : (
      card
    );
  }
);

FeedCard.displayName = 'FeedCard';

type Props = CardProps & {
  children: React.ReactNode;
  href?: string;
  aspectRatio?: AspectRatio;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  useCSSAspectRatio?: boolean;
  cardDecoration?: any;
  inViewOptions?: any;
};
