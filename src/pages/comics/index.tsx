import { Stack } from '@mantine/core';
import { useRouter } from 'next/router';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { ComicGenreScroller } from '~/components/Comics/ComicGenreScroller';
import { ComicsInfinite } from '~/components/Comics/ComicsInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';

function ComicsBrowse() {
  const router = useRouter();
  const genre = (router.query.genre as string) || undefined;
  const sort = ((router.query.sort as string) || 'Newest') as
    | 'Newest'
    | 'MostFollowed'
    | 'MostChapters';
  const period = (router.query.period as string) || undefined;
  const followed = router.query.followed === 'true' || undefined;

  const setQuery = (updates: Record<string, string | undefined>) => {
    const query = { ...router.query };
    for (const [key, val] of Object.entries(updates)) {
      if (val === undefined) {
        delete query[key];
      } else {
        query[key] = val;
      }
    }
    void router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
  };

  return (
    <>
      <Meta title="Comics - Civitai" description="Browse AI-generated comics on Civitai" />
      <MasonryContainer>
        <Stack gap="xs">
          <ComicGenreScroller value={genre} onChange={(g) => setQuery({ genre: g })} />
          <ComicsInfinite filters={{ genre, sort, period, followed }} showEof />
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(ComicsBrowse, { InnerLayout: FeedLayout });
