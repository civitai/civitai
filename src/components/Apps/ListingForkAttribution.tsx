import { Anchor, Text } from '@mantine/core';
import { IconGitFork } from '@tabler/icons-react';
import Link from 'next/link';

import { getListingDetailHref } from '~/components/Apps/appListingCardView';
import type { ListingForkOf } from '~/server/schema/blocks/app-listing-read.schema';
import { FORKED_FROM_PREFIX, FORKED_FROM_UNAVAILABLE } from '~/shared/constants/app-fork.constants';

/**
 * "Forked from {parent}" on a fork's store page.
 *
 * Provenance, so it is NOT behind the fork rollout flag: once a listing is a fork it says so. The
 * server decides what may be named — `forkOf.visible` is true only when this viewer may open the
 * parent's store page — and this component adds no policy: a hidden or deleted parent renders the
 * generic sentence, never a name.
 */
export function ListingForkAttribution({ forkOf }: { forkOf: ListingForkOf | null | undefined }) {
  if (!forkOf) return null;
  return (
    <Text size="sm" c="dimmed" data-testid="apps-listing-forked-from">
      <IconGitFork
        size={14}
        aria-hidden
        style={{ verticalAlign: '-2px', marginRight: 4, display: 'inline-block' }}
      />
      {forkOf.visible ? (
        <>
          {FORKED_FROM_PREFIX}
          <Anchor
            component={Link}
            href={getListingDetailHref(forkOf.slug)}
            inherit
            data-testid="apps-listing-forked-from-link"
          >
            {forkOf.name}
          </Anchor>
        </>
      ) : (
        FORKED_FROM_UNAVAILABLE
      )}
    </Text>
  );
}
