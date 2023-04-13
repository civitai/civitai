import { Container, Stack, Group, createStyles, Box, Center, Title, Text } from '@mantine/core';
import { InferGetServerSidePropsType } from 'next/types';
import { InfiniteModels } from '~/components/InfiniteModels/InfiniteModels';
import {
  InfiniteModelsSort,
  InfiniteModelsPeriod,
  InfiniteModelsFilter,
} from '~/components/InfiniteModels/InfiniteModelsFilters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { constants } from '~/server/common/constants';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { constants } from '~/server/common/constants';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const tagname = ctx.query.tagname as string;
    if (tagname) await ssg?.tag.getTagWithModelCount.prefetch({ name: tagname });

    return { props: { tagname } };
  },
});

export default function TagPage({
  tagname,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { classes } = useStyles();

  const { data = [] } = trpc.tag.getTagWithModelCount.useQuery({ name: tagname });
  const [tag] = data;

  const count = tag?.count ?? 0;

  return (
    <>
      <Meta
        title={`${tag?.name} Stable Diffusion AI Models | Civitai`}
        description={`Browse ${tag?.name} Stable Diffusion models, checkpoints, hypernetworks, textual inversions, embeddings, Aesthetic Gradients, and LORAs`}
      />
      {tag && (
        <Box className={classes.banner} mb="md">
          <Center>
            <Stack spacing="xs">
              <Title order={1} align="center">
                {tag.name}
              </Title>
              <Text transform="uppercase" align="center">
                {count} {count === 1 ? 'model' : 'models'}
              </Text>
            </Stack>
          </Center>
        </Box>
      )}
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid>
          <Stack spacing="xs">
            <Group position="apart">
              <InfiniteModelsSort />
              <Group spacing="xs">
                <InfiniteModelsPeriod />
                <InfiniteModelsFilter />
              </Group>
            </Group>
            <InfiniteModels />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </>
  );
}

const useStyles = createStyles((theme) => ({
  banner: {
    marginTop: `-${theme.spacing.md}px`,
    paddingTop: theme.spacing.xl * 2,
    paddingBottom: theme.spacing.xl * 2,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[1],

    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
      paddingTop: theme.spacing.md,
      paddingBottom: theme.spacing.md,
    },
  },
  image: {
    width: '128px',
    borderRadius: theme.radius.sm,
    overflow: 'hidden',
  },
  wrapper: {
    alignItems: 'flex-start',
    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
      alignItems: 'center',
    },
  },
  outsideImage: {
    display: 'none',
    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
      display: 'block',
    },
  },
  insideImage: {
    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
      display: 'none',
    },
  },
  card: {
    [`@media (max-width: ${theme.breakpoints.xs}px)`]: {
      width: '100%',
    },
  },
}));
