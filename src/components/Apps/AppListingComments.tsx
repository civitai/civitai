import { Button, Center, Divider, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { IconMessageCancel } from '@tabler/icons-react';
import { Comment } from '~/components/CommentsV2/Comment/Comment';
import { CreateComment } from '~/components/CommentsV2/Comment/CreateComment';
import classes from '~/components/CommentsV2/Comment/Comment.module.css';
import { RootThreadProvider } from '~/components/CommentsV2/CommentsProvider';
import HiddenCommentsModal from '~/components/CommentsV2/HiddenCommentsModal';
import { ReturnToRootThread } from '~/components/CommentsV2/ReturnToRootThread';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { SortFilter } from '~/components/Filters';
import type { ThreadSort } from '~/server/common/enums';

/**
 * App Store Listings (W13) — the CommentsV2 discussion on an app-listing detail
 * page. Mirrors `Model3DComments`/`ArticleDetailComments` for the new entity type
 * `appListing`; the entity type is registered in `commentv2.schema.ts` and the
 * thread attaches via `Thread.appListingId` (→ `app_listings.serial_id`).
 *
 * Reuse: EVERYTHING here (write/read/pagination/sort + the inherited moderation —
 * lock/hide/pin/report/rate-limit) is the shared CommentsV2 stack keyed on the
 * Thread; there is NO per-listing permission logic. Additive + separate from the
 * existing recommend-style `app_listing_reviews` (`AppListingReviews`).
 *
 * Gating: `serialId` is the listing's integer surrogate, carried only on the public
 * `ListingDetail` DTO — which `getListingDetail` returns for APPROVED listings only
 * (a draft/pending/rejected/removed or non-deployed listing 404s server-side, so it
 * never reaches this body). We additionally render nothing when `serialId` is
 * missing (defense-in-depth: no thread key ⇒ no comments surface).
 */
export function AppListingComments({
  serialId,
  ownerUserId,
}: {
  /** `app_listings.serial_id` — the CommentsV2 thread key (integer). */
  serialId: number | null | undefined;
  /** Listing owner (developer) — badged "op" in the thread. Null when unknown. */
  ownerUserId?: number | null;
}) {
  if (serialId == null) return null;

  return (
    <RootThreadProvider
      entityType="appListing"
      entityId={serialId}
      // Short discussion preview + "Load more" CTA, matching the other detail pages.
      limit={5}
      hideWhenLocked
      badges={ownerUserId ? [{ userId: ownerUserId, label: 'op', color: 'violet' }] : undefined}
    >
      {({
        data,
        created,
        isLoading,
        isFetching,
        isFetchingNextPage,
        isLocked,
        showMore,
        hiddenCount,
        toggleShowMore,
        sort,
        setSort,
        activeComment,
      }) =>
        isLocked ? null : (
          <Stack mt="xl" gap="xl" data-testid="app-listing-comments">
            <Divider />
            <Stack gap={0}>
              <Group justify="space-between">
                <Group gap="md">
                  <Title order={4}>Discussion</Title>
                  {hiddenCount > 0 && !isLoading && (
                    <Button
                      variant="subtle"
                      onClick={() =>
                        dialogStore.trigger({
                          component: HiddenCommentsModal,
                          props: { entityId: serialId, entityType: 'appListing', userId: ownerUserId ?? undefined },
                        })
                      }
                      size="compact-xs"
                    >
                      <Group gap={4} justify="center">
                        <IconMessageCancel size={16} />
                        <Text inherit inline>
                          {`See ${hiddenCount} more hidden ${
                            hiddenCount > 1 ? 'comments' : 'comment'
                          }`}
                        </Text>
                      </Group>
                    </Button>
                  )}
                </Group>
                <SortFilter
                  type="threads"
                  value={sort}
                  onChange={(v) => setSort(v as ThreadSort)}
                />
              </Group>
              <ReturnToRootThread />
            </Stack>
            {isLoading || isFetching ? (
              <Center mt="xl">
                <Loader type="bars" />
              </Center>
            ) : (
              <>
                {activeComment && (
                  <Stack gap="xl">
                    <Divider />
                    <Text size="sm" c="dimmed">
                      Viewing thread for
                    </Text>
                    <Comment comment={activeComment} viewOnly />
                  </Stack>
                )}
                <Stack
                  gap="xl"
                  className={activeComment ? classes.rootCommentReplyInset : undefined}
                >
                  <CreateComment />
                  <Stack className="relative" gap="xl">
                    {data?.map((comment) => (
                      <Comment key={comment.id} comment={comment} resourceOwnerId={ownerUserId ?? undefined} />
                    ))}
                  </Stack>
                  {showMore && (
                    <Center>
                      <Button
                        onClick={toggleShowMore}
                        loading={isFetchingNextPage}
                        variant="subtle"
                        size="md"
                      >
                        Load More Comments
                      </Button>
                    </Center>
                  )}
                  {created.map((comment) => (
                    <Comment key={comment.id} comment={comment} resourceOwnerId={ownerUserId ?? undefined} />
                  ))}
                </Stack>
              </>
            )}
          </Stack>
        )
      }
    </RootThreadProvider>
  );
}
