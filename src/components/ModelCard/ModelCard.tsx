import { Box, Card, createStyles } from '@mantine/core';
import Image from 'next/image';
import Link from 'next/link';

type ModelCardProps = {
  id: number;
  name: string;
  description?: string;
};

export function ModelCard({ id, name, description }: ModelCardProps) {
  const { classes, cx } = useStyles();

  return (
    <Link href={`models/${id}`}>
      <Card withBorder shadow="sm" className={classes.card}>
        <Image
          src="/images/forest.webp"
          alt={name}
          layout="fill"
          objectFit="cover"
          objectPosition="top"
        />
        <Box p="md" className={classes.content}>
          Content
        </Box>
      </Card>
    </Link>
  );
}

const useStyles = createStyles((theme) => ({
  card: {
    height: '300px',
  },
  content: {
    background: 'inherit',
    position: 'absolute',
    bottom: 0,
    right: 0,
    left: 0,
  },
}));
