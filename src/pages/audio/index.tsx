import { Stack } from '@mantine/core';
import { Announcements } from '~/components/Announcements/Announcements';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { IsClient } from '~/components/IsClient/IsClient';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client.mjs';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { AudioCard } from '~/components/Cards/AudioCard';
import { useImageFilters } from '~/components/Image/image.utils';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features || !features.audio) return { notFound: true };

    return { props: {} };
  },
});

export default function AudioFeedPage() {
  const { hidden, ...filters } = useImageFilters('audio');

  return (
    <>
      <Meta
        title="Civitai Audio Gallery | AI-Generated Music Showcase"
        description="See the latest sounds created by the generative AI art community and delve into the inspirations and prompts behind their work"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/audio`, rel: 'canonical' }]}
      />
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
          <ImagesInfinite
            filters={{ ...filters, types: ['audio'] }}
            renderItem={AudioCard}
            showEof
            showAds
          />
        </IsClient>
      </Stack>
    </>
  );
}

setPageOptions(AudioFeedPage, { innerLayout: FeedLayout });
