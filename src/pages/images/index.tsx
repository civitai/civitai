import { Stack, Group } from '@mantine/core';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { hideMobile, showMobile } from '~/libs/sx-helpers';
import { Announcements } from '~/components/Announcements/Announcements';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { ImageFiltersDropdown } from '~/components/Image/Infinite/ImageFiltersDropdown';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { constants } from '~/server/common/constants';
import { ImageSort } from '~/components/Image/Filters/ImageSort';
import { ImagePeriod } from '~/components/Image/Filters/ImagePeriod';

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
              <ImageSort type="images" />
            </Group>
            <Group spacing={4}>
              <ImagePeriod type="images" />
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
