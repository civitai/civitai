import { AspectRatio, Card, CardProps, createStyles } from '@mantine/core';
import Link from 'next/link';

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

export function FeedCard({ href, children, aspectRatio = 'portrait', className, ...props }: Props) {
  const { ratio } = aspectRatioValues[aspectRatio];
  const { classes, cx } = useStyles();

  const card = (
    <Card<'a'>
      className={cx(classes.root, className)}
      {...props}
      component={href ? 'a' : undefined}
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

type Props = CardProps & {
  children: React.ReactNode;
  href?: string;
  aspectRatio?: AspectRatio;
};
