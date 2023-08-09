import { useInfiniteHits, useInstantSearch } from 'react-instantsearch-hooks-web';
import { useInView } from 'react-intersection-observer';
import { useEffect } from 'react';
import { Box, Center, createStyles, Loader, Stack } from '@mantine/core';
import { ModelGetAll } from '~/types/router';
import { ModelCard } from '~/components/Cards/ModelCard';

const useStyles = createStyles((theme) => ({
  grid: {
    display: 'grid',
    gridTemplateColumns: `repeat(auto-fill, minmax(250px, 1fr))`,
    columnGap: theme.spacing.md,
    gridTemplateRows: `auto 1fr`,
    overflow: 'hidden',
    marginTop: -theme.spacing.md,

    '& > *': {
      marginTop: theme.spacing.md,
    },
  },
}));

export function ModelsHitList() {
  const { hits, showMore, isLastPage } = useInfiniteHits();
  const { status } = useInstantSearch();
  const { ref, inView } = useInView();
  const { classes } = useStyles();

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView && status === 'idle' && !isLastPage) {
      showMore?.();
    }
  }, [status, inView, showMore, isLastPage]);

  return (
    <Stack>
      <Box className={classes.grid}>
        {hits.map((hit) => {
          const modelHit = hit as unknown as ModelGetAll['items'][number];
          const images = (hit.images ?? []) as ModelGetAll['items'][number]['image'][];

          const model = {
            ...modelHit,
            image: images[0],
          };

          return <ModelCard key={modelHit.id} data={model} />;
        })}
      </Box>
      {hits.length > 0 && (
        <Center ref={ref} sx={{ height: 36 }} mt="md">
          {!isLastPage && status === 'idle' && <Loader />}
        </Center>
      )}
    </Stack>
  );
}
