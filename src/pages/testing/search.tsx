import {
  Container,
  Title,
  Text,
  Group,
  Stack,
  Box,
  Accordion,
  Chip,
  Loader,
  Center,
  MultiSelect,
} from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import {
  InstantSearch,
  useRefinementList,
  RefinementListProps,
  useInfiniteHits,
  useInstantSearch,
  SortByProps,
  useSortBy,
} from 'react-instantsearch-hooks-web';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';

import { env } from '~/env/client.mjs';
import { ModelCard } from '~/components/Cards/ModelCard';
import { ModelGetAll } from '~/types/router';
import { useInView } from 'react-intersection-observer';
import { useDebouncedValue } from '@mantine/hooks';

const searchClient = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id', keepZeroFacets: true }
);

export default function Search() {
  return (
    <InstantSearch searchClient={searchClient} indexName="models" routing={true}>
      <Container fluid>
        <Stack
          sx={(theme) => ({
            height: 'calc(100vh - 2 * var(--mantine-header-height,50px))',
            position: 'fixed',
            left: 0,
            top: 'var(--mantine-header-height,50px)',
            width: '350px',
            overflowY: 'auto',
            padding: theme.spacing.md,
          })}
        >
          <Sorter
            items={[
              { label: 'Most downloaded', value: 'metrics.downloadCount' },
              { label: 'Highest Rated', value: 'metrics.rating' },
              { label: 'Favorited Count', value: 'metrics.favoriteCount' },
              { label: 'Newest', value: 'createdAt' },
            ]}
          />
          <ChipRefinementList
            title="Filter by Base Model"
            attribute="modelVersion.baseModel"
            sortBy={['name']}
          />
          <ChipRefinementList title="Filter by Model Type" attribute="type" sortBy={['name']} />
          <ChipRefinementList
            title="Filter by Checkpoint Type"
            sortBy={['name']}
            attribute="checkpointType"
          />
          <SearchableMultiSelectRefinementList title="Tags" attribute="tags" limit={10} />
        </Stack>

        <Stack pl={350} w="100%">
          <Title>Models Search experience</Title>
          <HitList />
        </Stack>
      </Container>
    </InstantSearch>
  );
}

function ChipRefinementList({ title, ...props }: RefinementListProps & { title: string }) {
  const { items, refine } = useRefinementList({ ...props });

  return (
    <Accordion defaultValue={props.attribute} variant="filled">
      <Accordion.Item value={props.attribute}>
        <Accordion.Control>
          <Text size="md" weight={500}>
            {title}
          </Text>
        </Accordion.Control>
        <Accordion.Panel>
          <Group spacing="xs">
            {items.map((item) => (
              <Chip
                size="sm"
                key={item.value}
                checked={item.isRefined}
                onClick={() => refine(item.value)}
              >
                {item.label}
              </Chip>
            ))}
          </Group>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

function SearchableMultiSelectRefinementList({
  title,
  ...props
}: RefinementListProps & { title: string }) {
  const { items, refine, searchForItems, isFromSearch } = useRefinementList({ ...props });
  const [searchValue, setSearchValue] = useState('');
  const [debouncedSearchValue] = useDebouncedValue(searchValue, 300);
  // We need to keep the state of the select here because the items may dissapear while searching.
  const [refinedItems, setRefinedItems] = useState<typeof items>([]);

  const onUpdateSelection = (updatedSelectedItems: string[]) => {
    const addedItems = updatedSelectedItems.length > refinedItems.length;
    if (addedItems) {
      // Get the last item:
      const lastAddedValue = updatedSelectedItems[updatedSelectedItems.length - 1];
      const item = items.find((item) => item.value === lastAddedValue);

      if (!item) {
        return;
      }

      refine(item.value);
      setRefinedItems([...refinedItems, item]);
    } else {
      // Remove the item that was removed:
      const removedItem = refinedItems.filter(
        (item) => !updatedSelectedItems.includes(item.value)
      )[0];

      if (!removedItem) {
        return;
      }

      refine(removedItem.value);
      setRefinedItems(refinedItems.filter((item) => item.value !== removedItem.value));
    }
  };

  useEffect(() => {
    searchForItems(debouncedSearchValue);
  }, [debouncedSearchValue]);

  return (
    <Accordion defaultValue={props.attribute} variant="filled">
      <Accordion.Item value={props.attribute}>
        <Accordion.Control>
          <Text size="md" weight={500}>
            {title}
          </Text>
        </Accordion.Control>
        <Accordion.Panel>
          <MultiSelect
            data={isFromSearch ? [...refinedItems, ...items] : items}
            value={refinedItems.map((item) => item.value)}
            onChange={onUpdateSelection}
            searchable
            searchValue={searchValue}
            onSearchChange={setSearchValue}
            nothingFound="Nothing found"
          />
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

function HitList() {
  const { hits, showMore, isLastPage } = useInfiniteHits();
  const { status } = useInstantSearch();
  const { ref, inView } = useInView();

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView && status === 'idle') {
      showMore?.();
    }
  }, [status, inView, showMore]);

  return (
    <Stack>
      <Box
        sx={(theme) => ({
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fill, minmax(250px, 1fr))`,
          columnGap: theme.spacing.md,
          gridTemplateRows: `auto 1fr`,
          overflow: 'hidden',
          marginTop: -theme.spacing.md,

          '& > *': {
            marginTop: theme.spacing.md,
          },
        })}
      >
        {hits.map((hit) => {
          const modelHit = hit as unknown as ModelGetAll['items'][number];
          const model = {
            ...modelHit,
            image: (hit.images?.[0] ?? null) as ModelGetAll['items'][number]['image'],
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

function Sorter(props: SortByProps) {
  const x = useSortBy(props);

  console.log(x, 'sorter');

  return null;
}
