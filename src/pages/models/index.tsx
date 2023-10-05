import { ActionIcon, Button, Group, Popover, Stack, Title } from '@mantine/core';
import { IconExclamationMark } from '@tabler/icons-react';
import { Announcements } from '~/components/Announcements/Announcements';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { PeriodFilter, SortFilter, ViewToggle } from '~/components/Filters';
import { FullHomeContentToggle } from '~/components/HomeContentToggle/FullHomeContentToggle';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { ModelCategoriesInfinite } from '~/components/Model/Categories/ModelCategoriesInfinite';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { env } from '~/env/client.mjs';
import { hideMobile, showMobile } from '~/libs/sx-helpers';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { constants } from '~/server/common/constants';
import { PeriodMode } from '~/server/schema/base.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { QS } from '~/utils/qs';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ ctx, features }) => {
    if (!features?.alternateHome) {
      const queryString = QS.stringify(ctx.query);

      return {
        redirect: {
          destination: `/${queryString ? '?' + queryString : ''}`,
          permanent: false,
        },
      };
    }
  },
});

export default function ModelsPage() {
  const features = useFeatureFlags();
  const storedView = useFiltersContext((state) => state.models.view);
  const { set, view: queryView, ...queryFilters } = useModelQueryParams();
  const { username, favorites, hidden, query, collectionId } = queryFilters;
  const periodMode = query || favorites ? ('stats' as PeriodMode) : undefined;
  if (periodMode) queryFilters.periodMode = periodMode;
  const canToggleView = !username && !favorites && !hidden && !collectionId;
  const view = canToggleView ? queryView ?? storedView : 'feed';

  return (
    <>
      <Meta
        title="Civitai Models | Discover Free Stable Diffusion Models"
        description="Browse from thousands of free Stable Diffusion models, spanning unique anime art styles, immersive 3D renders, stunning photorealism, and more"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/models`, rel: 'canonical' }]}
      />
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid>
          {username && typeof username === 'string' && <Title>Models by {username}</Title>}
          {favorites && <Title>Your Liked Models</Title>}
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
            <Group position="left">
              {features.alternateHome ? (
                <FullHomeContentToggle />
              ) : (
                <HomeContentToggle sx={showMobile} />
              )}
            </Group>
            <Group position="apart" spacing={0}>
              <Group>
                {!features.alternateHome && <HomeContentToggle sx={hideMobile} />}
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
    </>
  );
}
