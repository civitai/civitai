import { Group, Stack } from '@mantine/core';
import { Announcements } from '~/components/Announcements/Announcements';
import { PeriodFilter, SortFilter, ViewToggle } from '~/components/Filters';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { ImageCategoriesInfinite } from '~/components/Image/Categories/ImageCategoriesInfinite';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { useImageQueryParams } from '~/components/Image/image.utils';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { hideMobile, showMobile } from '~/libs/sx-helpers';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { constants } from '~/server/common/constants';

export default function ImagesPage() {
  const currentUser = useCurrentUser();
  const storedView = useFiltersContext((state) => state.images.view);
  const { view: queryView, ...filters } = useImageQueryParams();

  const view = queryView ?? storedView;
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
            <HomeContentToggle sx={showMobile} />
            <Group position="apart" spacing={0}>
              <Group>
                <HomeContentToggle sx={hideMobile} />
                <SortFilter type="images" />
              </Group>
              <Group spacing={4}>
                <PeriodFilter type="images" />
                <ViewToggle type="images" />
                {/* <ImageFiltersDropdown /> */}
              </Group>
            </Group>
            {view === 'categories' ? (
              <ImageCategoriesInfinite filters={filters} />
            ) : (
              <>
                <ImageCategories />
                <ImagesInfinite filters={filters} />
              </>
            )}
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </>
  );
}
