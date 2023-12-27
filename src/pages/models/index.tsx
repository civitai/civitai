import { ActionIcon, Button, Group, Popover, Stack, Title, createStyles } from '@mantine/core';
import { IconExclamationMark } from '@tabler/icons-react';
import { Announcements } from '~/components/Announcements/Announcements';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { SortFilter, ViewToggle } from '~/components/Filters';
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
import { containerQuery } from '~/utils/mantine-css-helpers';

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

const useStyles = createStyles(() => ({
  filtersWrapper: {
    [containerQuery.smallerThan('sm')]: {
      width: '100%',

      '> *': { flexGrow: 1 },
    },
  },
}));

export default function ModelsPage() {
  const features = useFeatureFlags();
  const { classes, theme } = useStyles();
  const storedView = useFiltersContext((state) => state.models.view);
  const { set, view: queryView, ...queryFilters } = useModelQueryParams();
  const { username, favorites, hidden, query, collectionId } = queryFilters;
  const periodMode = query || favorites ? ('stats' as PeriodMode) : undefined;
  if (periodMode) queryFilters.periodMode = periodMode;
  const canToggleView =
    env.NEXT_PUBLIC_UI_CATEGORY_VIEWS && !username && !favorites && !hidden && !collectionId;
  const view =
    env.NEXT_PUBLIC_UI_CATEGORY_VIEWS && canToggleView ? queryView ?? storedView : 'feed';

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
              sx={() => ({
                marginBottom: -35,
                [containerQuery.smallerThan('md')]: {
                  marginBottom: -5,
                },
              })}
            />
            <Group position="apart" spacing={8}>
              {features.alternateHome ? <FullHomeContentToggle /> : <HomeContentToggle />}
              <Group className={classes.filtersWrapper} spacing={4}>
                {periodMode && (
                  <Popover>
                    <Popover.Target>
                      <ActionIcon variant="filled" color="blue" radius="xl" size={36} mr={4}>
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
                <SortFilter type="models" variant="button" />
                <ModelFiltersDropdown />
                {canToggleView && (
                  <ViewToggle
                    type="models"
                    color="gray"
                    radius="xl"
                    size={36}
                    variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                  />
                )}
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
