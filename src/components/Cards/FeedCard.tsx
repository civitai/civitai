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

const useStyles = createStyles<string, { height: number }>((theme, { height }) => ({
  root: {
    padding: '0 !important',
    color: 'white',
    borderRadius: theme.radius.sm,
    minHeight: 280,
  },
}));

export function FeedCard({ href, children, aspectRatio = 'portrait', className, ...props }: Props) {
  const { ratio, height } = aspectRatioValues[aspectRatio];
  const { classes, cx } = useStyles({ height });

  const card = (
    <Card<'a'>
      className={cx(classes.root, className)}
      {...props}
      component={href ? 'a' : undefined}
    >
      <AspectRatio
        // h={height}
        ratio={ratio}
        w="100%"
      >
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
