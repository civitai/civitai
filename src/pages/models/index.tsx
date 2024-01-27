import { Stack, Title } from '@mantine/core';
import { Announcements } from '~/components/Announcements/Announcements';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { IsClient } from '~/components/IsClient/IsClient';
import { Meta } from '~/components/Meta/Meta';
import { ModelCategoriesInfinite } from '~/components/Model/Categories/ModelCategoriesInfinite';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { env } from '~/env/client.mjs';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { PeriodMode } from '~/server/schema/base.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';
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
        <IsClient>
          {view === 'categories' ? (
            <ModelCategoriesInfinite />
          ) : (
            <>
              <CategoryTags />
              <ModelsInfinite filters={queryFilters} showEof showAds />
            </>
          )}
        </IsClient>
      </Stack>
    </>
  );
}

setPageOptions(ModelsPage, { innerLayout: FeedLayout });
