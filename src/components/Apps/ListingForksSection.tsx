import { Anchor, Button, Stack, Title } from '@mantine/core';
import Link from 'next/link';

import { getListingDetailHref } from '~/components/Apps/appListingCardView';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { forkCountLabel, LISTING_FORKS_PAGE_DEFAULT } from '~/shared/constants/app-fork.constants';
import { trpc } from '~/utils/trpc';

/**
 * "N forks" and the list of a listing's PUBLISHED forks, on its store page.
 *
 * Behind the `app-blocks-fork` rollout flag on BOTH sides: while the client flag is off nothing
 * below mounts, so no request is issued and no tRPC hook is even touched (every surface that
 * renders the store page keeps working unchanged); the server answers `null` for a viewer its own
 * flag check does not admit, so a stale client flag shows nothing rather than an error. Renders
 * nothing for a listing with no visible forks — "0 forks" is noise on every app nobody forked.
 *
 * The server decides what counts (approved and store-visible to this viewer); this renders the
 * page it is given.
 */
export function ListingForksSection({ listingId }: { listingId: string }) {
  const features = useFeatureFlags();
  if (!features.appBlocksFork) return null;
  return <ListingForksList listingId={listingId} />;
}

function ListingForksList({ listingId }: { listingId: string }) {
  const forks = trpc.appListings.listForks.useInfiniteQuery(
    { listingId, limit: LISTING_FORKS_PAGE_DEFAULT },
    { getNextPageParam: (last) => last?.nextCursor ?? undefined }
  );

  const first = forks.data?.pages[0];
  if (!first || first.totalCount === 0) return null;
  const items = forks.data?.pages.flatMap((page) => page?.items ?? []) ?? [];

  return (
    <Stack gap="xs" data-testid="apps-listing-forks">
      <Title order={4} data-testid="apps-listing-forks-count">
        {forkCountLabel(first.totalCount)}
      </Title>
      <Stack component="ul" gap={4} m={0} pl="md" data-testid="apps-listing-forks-list">
        {items.map((fork) => (
          <li key={fork.id}>
            <Anchor component={Link} href={getListingDetailHref(fork.slug)} size="sm">
              {fork.name}
            </Anchor>
          </li>
        ))}
      </Stack>
      {forks.hasNextPage ? (
        <Button
          variant="default"
          size="xs"
          w="fit-content"
          loading={forks.isFetchingNextPage}
          onClick={() => void forks.fetchNextPage()}
          data-testid="apps-listing-forks-more"
        >
          Show more forks
        </Button>
      ) : null}
    </Stack>
  );
}
