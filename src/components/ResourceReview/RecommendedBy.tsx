import { Button, Text } from '@mantine/core';
import { IconThumbUp } from '@tabler/icons-react';

import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { trpc } from '~/utils/trpc';

/** The people who gave a version a thumbs-up without writing a review; renders nothing when there are none. */
export function RecommendedBy({
  modelId,
  modelVersionId,
}: {
  modelId: number;
  modelVersionId: number;
}) {
  const { data, hasNextPage, fetchNextPage, isFetchingNextPage } =
    trpc.resourceReview.getRecommendedBy.useInfiniteQuery(
      { modelId, modelVersionId },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );

  // A thumbs-up landing between pages shifts the offset, so one user can arrive twice.
  const users = [
    ...new Map(
      (data?.pages ?? []).flatMap((page) =>
        page.items.map((item) => [item.user.id, item.user] as const)
      )
    ).values(),
  ];
  if (!users.length) return null;

  return (
    <section aria-labelledby="recommended-by-heading" className="mt-6">
      <div className="mb-3 flex items-center gap-1.5">
        <IconThumbUp size={16} className="text-green-6" />
        <Text id="recommended-by-heading" component="h2" fw={600} className="text-[15px]">
          Recommended by
        </Text>
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-3 p-0">
        {users.map((user) => (
          <li key={user.id} className="min-w-0">
            <UserAvatar
              user={user}
              size="sm"
              avatarSize={28}
              spacing="xs"
              withUsername
              linkToProfile
            />
          </li>
        ))}
      </ul>
      {hasNextPage && (
        <Button
          variant="default"
          size="compact-md"
          mt="md"
          loading={isFetchingNextPage}
          onClick={() => fetchNextPage()}
        >
          Show more
        </Button>
      )}
    </section>
  );
}
