import { AspectRatio, Card, CardProps, createStyles } from '@mantine/core';
import Link from 'next/link';
import React, { forwardRef, cloneElement } from 'react';
import { CardDecoration } from '../Decorations/HolidayFrame';

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

const useStyles = createStyles<string, { aspectRatio?: string }>((theme, { aspectRatio }) => {
  return {
    root: {
      padding: '0 !important',
      color: 'white',
      borderRadius: theme.radius.md,
      cursor: 'pointer',
      aspectRatio: aspectRatio,
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      // ...(aspectRatio
      //   ? {
      //       position: 'relative',
      //       height: 0,
      //       paddingBottom: `${(aspectRatio * 100).toFixed(3)}% !important`,
      //       overflow: 'hidden',
      //     }
      //   : {}),
    },
    child: {
      flex: 1,
    },
    cardDecoration: {},
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
    const { ratio, cssRatio, stringRatio } = aspectRatioValues[aspectRatio];
    const { classes, cx } = useStyles({ aspectRatio: stringRatio });

    // const {ref, inView} = useInView(inViewOptions)

    const card = (
      <Card<'a'>
        className={cx(classes.root, className)}
        {...props}
        component={href ? 'a' : undefined}
        ref={ref}
      >
        {cloneElement(children, { className: cx(classes.child, children.props.className) })}
        <CardDecoration {...cardDecoration} />
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
  children: React.ReactElement;
  href?: string;
  aspectRatio?: AspectRatio;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  useCSSAspectRatio?: boolean;
  cardDecoration?: any;
  inViewOptions?: any;
};
