import { Container } from '@mantine/core';
import { IconPhoto, IconPhotoOff } from '@tabler/icons-react';
import Link from 'next/link';

import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { trpc } from '~/utils/trpc';
import styles from './Comics.module.scss';

function ComicsBrowse() {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.comics.getPublicProjects.useInfiniteQuery(
      { limit: 20 },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );

  const items = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <Meta
        title="Browse Comics - Civitai"
        description="Browse AI-generated comics on Civitai"
      />

      <Container size="xl">
        <div className={styles.browseHeader}>
          <h1 className={styles.browseTitle}>Browse Comics</h1>
          <p className={styles.browseSubtitle}>
            Explore AI-generated comics from the community
          </p>
        </div>

        {isLoading ? (
          <div className={styles.loadingCenter}>
            <div className={styles.spinner} />
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

type ComicItem = ReturnType<
  typeof trpc.comics.getPublicProjects.useInfiniteQuery
>['data']['pages'][number]['items'][number];

function ComicCard({ comic }: { comic: ComicItem }) {
  return (
    <Link href={`/comics/read/${comic.id}`} className={styles.comicCard}>
      <div className={styles.comicCardImage}>
        {comic.thumbnailUrl ? (
          <>
            <img
              src={getEdgeUrl(comic.thumbnailUrl, { width: 450 })}
              alt={comic.name}
            />
            <div className={styles.comicCardOverlay}>
              <span className={styles.comicCardPanelBadge}>
                {comic.readyPanelCount} {comic.readyPanelCount === 1 ? 'panel' : 'panels'}
              </span>
            </div>
          </>
        ) : (
          <div className={styles.comicCardImageEmpty}>
            <IconPhoto size={36} />
          </div>
        )}
      </div>
      <div className={styles.comicCardBody}>
        <h3 className={styles.comicCardTitle}>{comic.name}</h3>
        {comic.description && (
          <p className={styles.comicCardDescription}>{comic.description}</p>
        )}
        <div className={styles.comicCardMeta}>
          <UserAvatarSimple {...comic.user} />
        </div>
      </div>
    </Link>
  );
}

export default Page(ComicsBrowse, { withScrollArea: false });
