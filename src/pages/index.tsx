import { Group, Stack, Title } from '@mantine/core';
import { Announcements } from '~/components/Announcements/Announcements';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';

import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { ModelFiltersDropdown } from '~/components/Model/Infinite/ModelFiltersDropdown';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { useModelQueryParams } from '~/components/Model/model.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { hideMobile, showMobile } from '~/libs/sx-helpers';
import { constants } from '~/server/common/constants';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ssg, session }) => {
    if (ssg) {
      if (session) {
        // Prefetch user's favorite models
        await ssg.user.getEngagedModels.prefetch(undefined);
        // Prefetch user's engaged models versions
        await ssg.user.getEngagedModelVersions.prefetch(undefined);
        // Prefetch users' blocked tags
        await ssg.user.getTags.prefetch({ type: 'Hide' });
      }
    }
  },
});

function Home() {
  const currentUser = useCurrentUser();
  const queryFilters = useModelQueryParams();
  const { username, favorites, hidden } = queryFilters;

  return (
    <>
      <Meta
        title={`Civitai${
          !currentUser ? ` | Stable Diffusion models, embeddings, hypernetworks and more` : ''
        }`}
        description="Civitai is a platform for Stable Diffusion AI Art models. We have a collection of over 1,700 models from 250+ creators. We also have a collection of 1200 reviews from the community along with 12,000+ images with prompts to get you started."
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
            <HomeContentToggle sx={showMobile} />
            <Group position="apart" spacing={0}>
              <Group>
                <HomeContentToggle sx={hideMobile} />
                <SortFilter type="models" />
              </Group>
              <Group spacing={4}>
                <PeriodFilter type="models" />
                <ModelFiltersDropdown />
              </Group>
            </Group>
            <CategoryTags />
            <ModelsInfinite filters={queryFilters} />
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </>
  );
}

// Home.getLayout = (page: React.ReactElement) => <>{page}</>;
export default Home;
