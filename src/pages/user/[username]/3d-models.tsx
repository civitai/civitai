import { Box, Center, Group, Loader, LoadingOverlay, Stack } from '@mantine/core';
import { keepPreviousData } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { Model3DCard } from '~/components/Cards/Model3DCard';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { FeedContentToggle } from '~/components/FeedContentToggle/FeedContentToggle';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryGridVirtual } from '~/components/MasonryColumns/MasonryGridVirtual';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { NoContent } from '~/components/NoContent/NoContent';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Model3DStatus } from '~/shared/utils/prisma/enums';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

/**
 * /user/[username]/3d-models — profile tab for a user's Model3D content.
 *
 * Mirrors `articles.tsx` structure (SSR flag/banned gates, SSG prefetch of
 * userProfile.{get,overview}, FeedContentToggle for self-view).
 *
 * Visibility:
 *  - Self-view: published/draft toggle, owner sees their own drafts via
 *    `includeDrafts` (service honors it when userId === user.id).
 *  - Moderator viewing someone else's profile: see all non-deleted statuses
 *    via the `statuses` escape hatch (the service allows any `statuses` when
 *    isModerator).
 *  - Everyone else: published only.
 */

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx, features, ssg }) => {
    const username = ctx.query.username as string;
    if (!features?.model3dFeed)
      return {
        redirect: { destination: `/user/${username}`, permanent: false },
      };

    const user = await dbRead.user.findUnique({
      where: { username },
      select: { bannedAt: true },
    });
    if (user?.bannedAt)
      return { redirect: { destination: `/user/${username}`, permanent: true } };

    await Promise.all([
      ssg?.userProfile.get.prefetch({ username }),
      ssg?.userProfile.overview.prefetch({ username }),
    ]);
  },
});

function UserModel3DsPage() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const username = (router.query.username as string) ?? '';

  const selfView =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);
  const isMod = !!currentUser?.isModerator;

  const [section, setSection] = useState<'published' | 'draft'>('published');
  const viewingDrafts = section === 'draft';

  const includeDrafts = selfView && viewingDrafts;
  // Mods viewing someone else's profile in "draft" mode see all non-published
  // statuses via the `statuses` escape hatch (service allows arbitrary statuses
  // for moderators).
  const statuses =
    isMod && !selfView && viewingDrafts
      ? [Model3DStatus.Draft, Model3DStatus.Unpublished]
      : undefined;

  const {
    data,
    isLoading,
    isRefetching,
    isFetching,
    hasNextPage,
    fetchNextPage,
  } = trpc.model3d.getInfinite.useInfiniteQuery(
    {
      limit: 50,
      username,
      includeDrafts,
      statuses,
    },
    {
      getNextPageParam: (last) => last.nextCursor,
      placeholderData: keepPreviousData,
    }
  );

  const items = data?.pages.flatMap((p) => p.items) ?? [];

  if (!username) return <NotFound />;

  return (
    <Box mt="md">
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer p={0}>
          <Stack gap="xs">
            {(selfView || isMod) && (
              <Group gap={8} justify="space-between">
                <FeedContentToggle
                  size="xs"
                  value={section}
                  onChange={(value) => setSection(value as 'published' | 'draft')}
                />
              </Group>
            )}

            {isLoading ? (
              <Center p="xl">
                <Loader size="xl" />
              </Center>
            ) : items.length ? (
              <div className="relative">
                <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
                <MasonryGridVirtual
                  data={items}
                  render={Model3DCard}
                  itemId={(x) => x.id}
                  empty={<NoContent />}
                />
                {hasNextPage && (
                  <InViewLoader
                    loadFn={fetchNextPage}
                    loadCondition={!isFetching}
                    style={{ gridColumn: '1/-1' }}
                  >
                    <Center p="xl" style={{ height: 36 }} mt="md">
                      <Loader />
                    </Center>
                  </InViewLoader>
                )}
                {!hasNextPage && <EndOfFeed />}
              </div>
            ) : (
              <NoContent
                py="lg"
                message={
                  selfView
                    ? viewingDrafts
                      ? 'No drafts yet. Generate a 3D model to get started.'
                      : "You haven't published any 3D models yet."
                    : 'No 3D models here yet.'
                }
              />
            )}
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </Box>
  );
}

export default Page(UserModel3DsPage, { getLayout: UserProfileLayout });
