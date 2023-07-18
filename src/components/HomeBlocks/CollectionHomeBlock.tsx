import {
  Button,
  Container,
  Grid,
  Group,
  ScrollArea,
  Stack,
  Title,
  createStyles,
} from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import Link from 'next/link';
import { ModelCard } from '~/components/Cards/ModelCard';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { HomeBlockGetAll } from '~/types/router';

const useStyles = createStyles((theme, _params, getRef) => {
  const gridItem = getRef('gridItem');

  return {
    title: {
      fontSize: 32,

      [theme.fn.smallerThan('sm')]: {
        fontSize: 28,
      },
    },

    gridContainer: {
      marginLeft: '-8px',
      padding: 0,

      [theme.fn.smallerThan('sm')]: {
        paddingRight: '45px',
      },
    },

    cardGrid: {
      [theme.fn.smallerThan('sm')]: {
        flexWrap: 'nowrap',

        [`& > .${gridItem}:last-child`]: {
          paddingRight: theme.spacing.md,
        },
      },
    },

    gridItem: {
      ref: gridItem,

      [theme.fn.smallerThan('sm')]: {
        paddingTop: 0,
        paddingBottom: 0,
      },
    },

    viewport: {
      [theme.fn.smallerThan('sm')]: {
        overflowY: 'hidden',
      },
    },

    expandButton: {
      height: 34,
    },
  };
});

export const CollectionHomeBlock = ({ homeBlock }: Props) => {
  const { classes } = useStyles();

  if (!homeBlock.collection) {
    return null;
  }

  return (
    <HomeBlockWrapper py={32} px={0} innerContainerProps={{ pr: 0 }}>
      <Stack spacing="xl">
        <Group spacing="xs" position="apart" noWrap>
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
        <ScrollArea type="never" viewportProps={{ style: { overflowY: 'hidden' } }}>
          <Container className={classes.gridContainer} fluid>
            <Grid className={classes.cardGrid} gutter="md" m={0}>
              {homeBlock.collection.items.map((item) => (
                <Grid.Col key={item.id} className={classes.gridItem} xs={12} sm={6} md={4} lg={3}>
                  {item.type === 'model' && <ModelCard data={item.data} />}
                </Grid.Col>
              ))}
            </Grid>
          </Container>
        </ScrollArea>
      </Stack>
    </HomeBlockWrapper>
  );
};

type Props = { homeBlock: HomeBlockGetAll[number] };
