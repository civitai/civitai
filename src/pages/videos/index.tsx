import { Stack, Title } from '@mantine/core';
import { Announcements } from '~/components/Announcements/Announcements';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { useImageFilters } from '~/components/Image/image.utils';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { IsClient } from '~/components/IsClient/IsClient';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client.mjs';

export default function VideosPage() {
  const { hidden, ...filters } = useImageFilters('videos');

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
        <IsClient>
          <ImageCategories />
          <ImagesInfinite filters={{ ...filters, types: ['video'] }} showEof showAds />
        </IsClient>
      </Stack>
    </>
  );
}

setPageOptions(VideosPage, { innerLayout: FeedLayout });
