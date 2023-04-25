import { Box, Center, createStyles, Group, Stack, Text, Title } from '@mantine/core';
import { MetricTimeframe } from '@prisma/client';
import { InferGetServerSidePropsType } from 'next/types';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { constants } from '~/server/common/constants';
import { ModelSort } from '~/server/common/enums';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

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
  const { set, ...queryFilters } = useModelQueryParams();
  const sort = queryFilters.sort ?? ModelSort.HighestRated;
  const period = queryFilters.period ?? MetricTimeframe.AllTime;

  const { data = [] } = trpc.tag.getTagWithModelCount.useQuery({ name: tagname });
  const [tag] = data;

  const { classes } = useStyles();
  const count = tag?.count ?? 0;

  return (
    <>
      <Meta
        title={`${tag?.name} Stable Diffusion AI Models | Agentswap`}
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
              <SortFilter type="models" value={sort} onChange={(x) => set({ sort: x as any })} />
              <Group spacing="xs">
                <PeriodFilter value={period} onChange={(x) => set({ period: x })} />
                <ModelFiltersDropdown />
              </Group>
            </Group>
            <ModelsInfinite filters={queryFilters} />
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
