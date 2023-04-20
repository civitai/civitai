import { Group, Stack } from '@mantine/core';
import { Announcements } from '~/components/Announcements/Announcements';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { hideMobile, showMobile } from '~/libs/sx-helpers';
import { constants } from '~/server/common/constants';

export default function ImagesPage() {
  return (
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
              {/* <ImageFiltersDropdown /> */}
            </Group>
          </Group>
          <ImageCategories />
          <ImagesInfinite />
        </Stack>
      </MasonryContainer>
    </MasonryProvider>
  );
}
