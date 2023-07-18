import { AspectRatio, Card, CardProps, createStyles } from '@mantine/core';
import Link from 'next/link';

type AspectRatio = 'portrait' | 'landscape' | 'square';
const aspectRatioValues: Record<AspectRatio, { ratio: number; height: number }> = {
  portrait: {
    ratio: 9 / 16,
    height: 430,
  },
  landscape: {
    ratio: 16 / 9,
    height: 300,
  },
  square: {
    ratio: 1,
    height: 332,
  },
};

const useStyles = createStyles<string, { height: number }>((theme, { height }) => ({
  root: {
    height,
    padding: '0 !important',
    color: 'white',
    borderRadius: theme.radius.sm,
    minHeight: 300,
  },
}));

export function FeedCard({ href, children, aspectRatio = 'portrait', className, ...props }: Props) {
  const { ratio, height } = aspectRatioValues[aspectRatio];
  const { classes, cx } = useStyles({ height });

  return (
    <Link href={href} passHref>
      <Card className={cx(classes.root, className)} {...props} component="a">
        <AspectRatio h={height} ratio={ratio}>
          {children}
        </AspectRatio>
      </Card>
    </Link>
  );
}

type Props = CardProps & {
  children: React.ReactNode;
  href: string;
  aspectRatio?: AspectRatio;
};
