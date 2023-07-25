import { ActionIcon, Button, Group, Popover, Stack, Title } from '@mantine/core';
import { IconExclamationMark } from '@tabler/icons-react';
import { Announcements } from '~/components/Announcements/Announcements';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { PeriodFilter, SortFilter, ViewToggle } from '~/components/Filters';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ModelCategoriesInfinite } from '~/components/Model/Categories/ModelCategoriesInfinite';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { hideMobile, showMobile } from '~/libs/sx-helpers';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { constants } from '~/server/common/constants';
import { PeriodMode } from '~/server/schema/base.schema';

export default function ModelsPage() {
  const storedView = useFiltersContext((state) => state.models.view);
  const { set, view: queryView, ...queryFilters } = useModelQueryParams();
  const { username, favorites, hidden, query, collectionId } = queryFilters;
  const periodMode = query || favorites ? ('stats' as PeriodMode) : undefined;
  if (periodMode) queryFilters.periodMode = periodMode;
  const canToggleView = !username && !favorites && !hidden && !collectionId;
  const view = canToggleView ? queryView ?? storedView : 'feed';

  return (
    <MasonryProvider
      columnWidth={constants.cardSizes.model}
      maxColumnCount={7}
      maxSingleColumnWidth={450}
    >
      <MasonryContainer fluid>
        {username && typeof username === 'string' && <Title>Models by {username}</Title>}
        {favorites && <Title>Your Liked Models</Title>}
        {/*TODO.collection: Add relevant collection title*/}
        {collectionId && <Title>Collection</Title>}
        {hidden && <Title>Your Hidden Models</Title>}
        <Stack spacing="xs">
          <Announcements
            sx={(theme) => ({
              marginBottom: -35,
              [theme.fn.smallerThan('md')]: {
                marginBottom: -5,
              },
            })}
          />
          <HomeContentToggle sx={showMobile} />
          <Group position="apart" spacing={0}>
            <Group>
              <HomeContentToggle sx={hideMobile} />
              <SortFilter type="models" />
            </Group>
            <Group spacing={4}>
              {periodMode && (
                <Popover>
                  <Popover.Target>
                    <ActionIcon variant="filled" color="blue" radius="xl" size="sm" mr={4}>
                      <IconExclamationMark size={20} strokeWidth={3} />
                    </ActionIcon>
                  </Popover.Target>
                  <Popover.Dropdown maw={300}>
                    {`To ensure that you see all possible results, we've disable the period filter.`}
                    <Button mt="xs" size="xs" fullWidth onClick={() => set({ query: undefined })}>
                      Clear Search
                    </Button>
                  </Popover.Dropdown>
                </Popover>
              )}
              <PeriodFilter type="models" />
              <ModelFiltersDropdown />
              {canToggleView && <ViewToggle type="models" />}
            </Group>
          </Group>
          <IsClient>
            {view === 'categories' ? (
              <ModelCategoriesInfinite />
            ) : (
              <>
                <CategoryTags />
                <ModelsInfinite filters={queryFilters} showEof />
              </>
            )}
          </IsClient>
        </Stack>
      </MasonryContainer>
    </MasonryProvider>
  );
}
