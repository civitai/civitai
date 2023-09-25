import { createStyles, Group, Stack } from '@mantine/core';
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
import { useCurrentUser } from '~/hooks/useCurrentUser';
// import { hideMobile, showMobile } from '~/libs/sx-helpers';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { ImageFiltersDropdown } from '~/components/Image/Filters/ImageFiltersDropdown';

const useStyles = createStyles((theme) => ({
  filtersWrapper: {
    [theme.fn.smallerThan('sm')]: {
      width: '100%',

      '> *': { flexGrow: 1 },
    },
  },
}));

export default function ImagesPage() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { view } = useImageFilters('images');
  const { classes, theme } = useStyles();

  return (
    <>
      <Meta
        title={`Civitai${
          !currentUser
            ? ` Image Gallery | Discover AI-Generated Images with Prompts and Resource Details`
            : ''
        }`}
        description="Browse the Civitai Image Gallery, featuring AI-generated images along with prompts and resources used for their creation, showcasing the creativity of our talented community."
      />
      <MasonryProvider
        columnWidth={constants.cardSizes.image}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid>
          <Stack spacing="xs">
            <Announcements
              sx={(theme) => ({
                marginBottom: -35,
                [theme.fn.smallerThan('md')]: {
                  marginBottom: -5,
                },
              })}
            />
            <Group position="apart" spacing={8}>
              {features.alternateHome ? <FullHomeContentToggle /> : <HomeContentToggle />}
              <Group className={classes.filtersWrapper} spacing={8} noWrap>
                <SortFilter type="images" variant="button" />
                <ImageFiltersDropdown />
                <ViewToggle
                  type="images"
                  color="gray"
                  radius="xl"
                  size={36}
                  variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                />
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
