import { Divider, Title } from '@mantine/core';
import { CommentSection } from '~/components/CommentsV3/CommentSection';

/**
 * The discussion on an app-listing detail page. Comments key on the listing's `serialId`, its
 * integer surrogate: the store id is a text ULID. `serialId` is only on the public detail of an
 * approved listing, so nothing renders without it.
 */
export function AppListingComments({
  serialId,
  ownerUserId,
}: {
  serialId: number | null | undefined;
  /** The listing's developer, badged "op". */
  ownerUserId?: number | null;
}) {
  if (serialId == null) return null;

  return (
    <div className="mt-8 flex flex-col gap-8" data-testid="app-listing-comments">
      <Divider />
      <CommentSection
        entityType="appListing"
        entityId={serialId}
        ownerId={ownerUserId ?? undefined}
        title={<Title order={2}>Discussion</Title>}
        hideWhenLocked
      />
    </div>
  );
}
