import { Box, Card, createStyles, Group, Stack, Text } from '@mantine/core';
import Image from 'next/image';
import Link from 'next/link';
import { StarRating } from '~/components/StarRating/StarRating';
import { GetAllModelsReturnType } from '~/server/services/models/getAllModels';

export function ModelCard({ id, name, image, metrics }: GetAllModelsReturnType['items'][0]) {
  const { classes, cx } = useStyles();

  // const hasDimensions = !!image.width && !!image.height;

  return (
    <Link href={`models/${id}`}>
      <Card withBorder shadow="sm" className={classes.card}>
        <Image
          src={image.url}
          alt={name}
          objectFit="cover"
          objectPosition="top"
          // height={hasDimensions ? `${image.height}px` : undefined}
          // width={hasDimensions ? `${image.width}px` : undefined}
          // layout={!hasDimensions ? 'fill' : undefined}
          layout="fill"
        />
        <Box p="sm" className={classes.content}>
          <Stack spacing="xs">
            <Text size={14}>{name}</Text>
            <Group position="apart">
              <StarRating rating={metrics.rating} />
            </Group>
          </Stack>
        </Box>
      </Card>
    </Link>
  );
}

const useStyles = createStyles((theme) => ({
  card: {
    height: '300px',
    cursor: 'pointer',
  },

  content: {
    background: 'inherit',
    position: 'absolute',
    bottom: 0,
    right: 0,
    left: 0,
  },
}));
