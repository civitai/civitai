import { createStyles, Group, Stack, Title } from '@mantine/core';
import { Announcements } from '~/components/Announcements/Announcements';
import { SortFilter } from '~/components/Filters';
import { FullHomeContentToggle } from '~/components/HomeContentToggle/FullHomeContentToggle';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { useImageFilters } from '~/components/Image/image.utils';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { env } from '~/env/client.mjs';
import { VideoFiltersDropdown } from '~/components/Image/Filters/VideoFiltersDropdown';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { setPageOptions } from '~/components/AppLayout/AppLayout';

const useStyles = createStyles((theme) => ({
  filtersWrapper: {
    [theme.fn.smallerThan('sm')]: {
      width: '100%',

      '> *': { flexGrow: 1 },
    },
  },
}));

export default function VideosPage() {
  const features = useFeatureFlags();
  const { hidden, ...filters } = useImageFilters('videos');
  const { classes } = useStyles();

  return (
    <>
      <Meta
        title="Civitai Video Gallery | AI-Generated Art Showcase"
        description="See the latest art created by the generative AI art community and delve into the inspirations and prompts behind their work"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/videos`, rel: 'canonical' }]}
      />
      {hidden && <Title>Your Hidden Videos</Title>}
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
            <SortFilter type="videos" variant="button" />
            <VideoFiltersDropdown />
          </Group>
        </Group>
        <IsClient>
          <ImageCategories />
          <ImagesInfinite filters={{ ...filters, types: ['video'] }} showEof />
        </IsClient>
      </Stack>
    </>
  );
}

setPageOptions(VideosPage, { innerLayout: FeedLayout });
