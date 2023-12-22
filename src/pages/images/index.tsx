import { createStyles, Group, Stack, Title } from '@mantine/core';
import { Announcements } from '~/components/Announcements/Announcements';
import { SortFilter, ViewToggle } from '~/components/Filters';
import { FullHomeContentToggle } from '~/components/HomeContentToggle/FullHomeContentToggle';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { ImageCategoriesInfinite } from '~/components/Image/Categories/ImageCategoriesInfinite';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { useImageFilters } from '~/components/Image/image.utils';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { ImageFiltersDropdown } from '~/components/Image/Filters/ImageFiltersDropdown';
import { env } from '~/env/client.mjs';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';

const useStyles = createStyles((theme) => ({
  filtersWrapper: {
    [containerQuery.smallerThan('sm')]: {
      width: '100%',

      '> *': { flexGrow: 1 },
    },
  },
}));

export default function ImagesPage() {
  const features = useFeatureFlags();
  const { view: queryView, hidden } = useImageFilters('images');
  const { classes, theme } = useStyles();
  const canToggleView = env.NEXT_PUBLIC_UI_CATEGORY_VIEWS && !hidden;
  const view = env.NEXT_PUBLIC_UI_CATEGORY_VIEWS && canToggleView ? queryView : 'feed';
  const currentUser = useCurrentUser();
  const canViewNewest = currentUser?.showNsfw ?? false;

  return (
    <>
      <Meta
        title="Civitai Gallery | AI-Generated Art Showcase"
        description="See the latest art created by the generative AI art community and delve into the inspirations and prompts behind their work"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/images`, rel: 'canonical' }]}
      />
      <MasonryProvider
        columnWidth={constants.cardSizes.image}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid>
          {hidden && <Title>Your Hidden Images</Title>}
          <Stack spacing="xs">
            <Announcements
              sx={(theme) => ({
                marginBottom: -35,
                [containerQuery.smallerThan('md')]: {
                  marginBottom: -5,
                },
              })}
            />
            <Group position="apart" spacing={8}>
              {features.alternateHome ? <FullHomeContentToggle /> : <HomeContentToggle />}
              <Group className={classes.filtersWrapper} spacing={8} noWrap>
                <SortFilter type="images" variant="button" includeNewest={canViewNewest} />
                <ImageFiltersDropdown />
                {canToggleView && (
                  <ViewToggle
                    type="images"
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
                <ImageCategoriesInfinite />
              ) : (
                <>
                  <ImageCategories />
                  <ImagesInfinite showEof />
                </>
              )}
            </IsClient>
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </>
  );
}
