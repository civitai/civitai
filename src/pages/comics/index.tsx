import { Stack } from '@mantine/core';
import { useRouter } from 'next/router';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { ComicGenreScroller } from '~/components/Comics/ComicGenreScroller';
import { ComicsInfinite } from '~/components/Comics/ComicsInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';

const sortOptions = [
  { label: 'Newest', value: 'Newest' },
  { label: 'Most Followed', value: 'MostFollowed' },
  { label: 'Most Chapters', value: 'MostChapters' },
] as const;

function ComicsBrowse() {
  const router = useRouter();
  const genre = (router.query.genre as string) || undefined;
  const sort = ((router.query.sort as string) || 'Newest') as
    | 'Newest'
    | 'MostFollowed'
    | 'MostChapters';

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
          <div className="flex items-center gap-2">
            <SelectMenuV2
              label={
                sort === 'MostFollowed'
                  ? 'Most Followed'
                  : sort === 'MostChapters'
                  ? 'Most Chapters'
                  : 'Newest'
              }
              options={[...sortOptions]}
              value={sort}
              onClick={(v) => setQuery({ sort: v })}
              size="compact-sm"
            />
          </div>
          <ComicsInfinite filters={{ genre, sort }} showEof />
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(ComicsBrowse, { InnerLayout: FeedLayout });
