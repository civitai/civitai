import { AspectRatio, Card, CardProps, createStyles } from '@mantine/core';
import Link from 'next/link';

type AspectRatio = 'portrait' | 'landscape' | 'square';
const aspectRatioValues: Record<AspectRatio, { ratio: number; maxHeight: number }> = {
  portrait: {
    ratio: 9 / 16,
    maxHeight: 430,
  },
  landscape: {
    ratio: 16 / 9,
    maxHeight: 300,
  },
  square: {
    ratio: 1,
    maxHeight: 332,
  },
};

const useStyles = createStyles<string, { maxHeight: number }>((theme, { maxHeight }) => ({
  root: { maxHeight, padding: '0 !important', color: 'white', borderRadius: theme.radius.sm },
}));

export function FeedCard({ href, children, aspectRatio = 'portrait', className, ...props }: Props) {
  const { ratio, maxHeight } = aspectRatioValues[aspectRatio];
  const { classes, cx } = useStyles({ maxHeight });

  return (
    <Link href={href} passHref>
      <Card className={cx(classes.root, className)} {...props} component="a">
        <AspectRatio mah={maxHeight} ratio={ratio}>
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
