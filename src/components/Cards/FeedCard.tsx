import { AspectRatio, Card, CardProps, createStyles } from '@mantine/core';
import Link from 'next/link';
import React from 'react';

type AspectRatio = 'portrait' | 'landscape' | 'square';
const aspectRatioValues: Record<AspectRatio, { ratio: number; height: number }> = {
  portrait: {
    ratio: 7 / 9,
    height: 430,
  },
  landscape: {
    ratio: 9 / 7,
    height: 300,
  },
  square: {
    ratio: 1,
    height: 332,
  },
};

const useStyles = createStyles<string>((theme) => ({
  root: {
    padding: '0 !important',
    color: 'white',
    borderRadius: theme.radius.md,
    cursor: 'pointer',
    // 280 = min column width based off of CollectionHomeBlock styles grid.
    // Min height based off of portrait as it's technically the smaller possible height wise.
    minHeight: 280 * aspectRatioValues['portrait'].ratio,
  },
}));

function FeedCardInner(
  { href, children, aspectRatio = 'portrait', className, ...props }: Props,
  ref?: React.ForwardedRef<any>
) {
  const { ratio } = aspectRatioValues[aspectRatio];
  const { classes, cx } = useStyles();

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

export const FeedCard = React.forwardRef(FeedCardInner);

type Props = CardProps & {
  children: React.ReactNode;
  href?: string;
  aspectRatio?: AspectRatio;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
};
