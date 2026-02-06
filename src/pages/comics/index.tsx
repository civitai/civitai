import { Container } from '@mantine/core';
import { IconAlertCircle, IconPhotoOff } from '@tabler/icons-react';
import { useRouter } from 'next/router';

import { Page } from '~/components/AppLayout/Page';
import { ComicCard } from '~/components/Cards/ComicCard';
import { Meta } from '~/components/Meta/Meta';
import type { ComicGenre } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';
import styles from './Comics.module.scss';

function ComicsBrowse() {
  const router = useRouter();

  const genre = (router.query.genre as string) || undefined;
  const period = (router.query.period as string) || undefined;
  const sort = ((router.query.sort as string) || 'Newest') as
    | 'Newest'
    | 'MostFollowed'
    | 'MostChapters';
  const followed = router.query.followed === 'true' || undefined;

  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage, refetch } =
    trpc.comics.getPublicProjects.useInfiniteQuery(
      {
        limit: 20,
        genre: genre as ComicGenre | undefined,
        period: period as 'Day' | 'Week' | 'Month' | 'Year' | 'AllTime' | undefined,
        sort,
        followed,
      },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );

  const items = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <Meta title="Comics - Civitai" description="Browse AI-generated comics on Civitai" />

      <Container size="xl">
        {isLoading ? (
          <div className={styles.loadingCenter}>
            <div className={styles.spinner} />
          </div>
        ) : isError ? (
          <div className={styles.browseEmpty}>
            <IconAlertCircle size={48} />
            <p>Failed to load comics</p>
            <button className={styles.loadMoreBtn} onClick={() => refetch()}>
              Try Again
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className={styles.browseEmpty}>
            <IconPhotoOff size={48} />
            <p>No comics published yet</p>
          </div>
        ) : (
          <>
            <div
              className="grid gap-5"
              style={{
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              }}
            >
              {items.map((comic) => (
                <ComicCard key={comic.id} comic={comic} />
              ))}
            </div>

            {hasNextPage && (
              <div className={styles.loadMore}>
                <button
                  className={styles.loadMoreBtn}
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {isFetchingNextPage ? 'Loading...' : 'Load More'}
                </button>
              </div>
            )}
          </>
        )}
      </Container>
    </>
  );
}

export default Page(ComicsBrowse);
