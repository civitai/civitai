import { Button, Group, Stack, Title, createStyles } from '@mantine/core';
import { Fragment } from 'react';
import { IconArrowRight } from '@tabler/icons-react';
import Link from 'next/link';
import { ImageCard } from '~/components/Cards/ImageCard';
import { ModelCard } from '~/components/Cards/ModelCard';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { HomeBlockGetAll } from '~/types/router';

const useStyles = createStyles<string, { count: number }>((theme, { count }) => {
  return {
    title: {
      fontSize: 32,

      [theme.fn.smallerThan('sm')]: {
        fontSize: 28,
      },
    },

    grid: {
      display: 'grid',
      gridTemplateColumns: 'repeat( auto-fit, minmax(280px, 1fr) )',
      gap: theme.spacing.md,

      [theme.fn.smallerThan('sm')]: {
        gridAutoFlow: 'column',
        gridTemplateColumns: `repeat(${count}, 280px)`,
        scrollSnapType: 'x mandatory',
        overflowX: 'auto',
        paddingLeft: theme.spacing.md,
        paddingRight: theme.spacing.md,

        '& > *': {
          scrollSnapAlign: 'center',
        },
      },
    },

    expandButton: {
      height: 34,
    },
  };
});

export const CollectionHomeBlock = ({ homeBlock }: Props) => {
  const { classes } = useStyles({ count: homeBlock.collection?.items.length ?? 0 });

  if (!homeBlock.collection) {
    return null;
  }

  return (
    <HomeBlockWrapper py={32} px={0} bleedRight>
      <Stack spacing="xl">
        <Group spacing="xs" position="apart" noWrap px="md">
          <Title className={classes.title} order={1} lineClamp={1}>
            {homeBlock.metadata.title ?? homeBlock.collection.name}
          </Title>
          {homeBlock.metadata.link && (
            <Link href={homeBlock.metadata.link} passHref>
              <Button
                className={classes.expandButton}
                component="a"
                variant="subtle"
                rightIcon={<IconArrowRight size={16} />}
              >
                {homeBlock.metadata.linkText ?? 'View All'}
              </Button>
            </Link>
          )}
        </Group>
        <div className={classes.grid}>
          {homeBlock.collection.items.map((item) => (
            <Fragment key={item.id}>
              {item.type === 'model' && <ModelCard data={item.data} />}
              {item.type === 'image' && (
                <ImageCard data={item.data} collectionId={homeBlock.collection?.id} />
              )}
            </Fragment>
          ))}
        </div>
      </Stack>
    </HomeBlockWrapper>
  );
};

type Props = { homeBlock: HomeBlockGetAll[number] };
