import { Button } from '@mantine/core';
import { IconGitFork } from '@tabler/icons-react';
import { useRouter } from 'next/router';

import type { BlockHostSurface } from '~/components/AppBlocks/blockInitFragmentGate';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';
import { FORK_ACTION_LABEL, FORK_QUERY_PARAM } from '~/shared/constants/app-fork.constants';
import { canAccessAppAssistant } from '~/shared/utils/app-blocks-access';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * FORKABLE APPS — the Fork action, on a listing's store page and in a running app's ⋮ menu.
 *
 * Clicking it calls `appListings.startFork` (which re-checks EVERY gate below on the server, plus
 * the rate limit and the parent's approved commit) and then opens App Assistant on the new fork
 * (`/apps/assistant?fork=<slug>`), where the page creates the user's copy and offers to set it up.
 *
 * 🔴 THE GATES HERE DECIDE AN AFFORDANCE, NEVER AN ENTITLEMENT. They exist so the button is not
 * offered to a viewer the server would refuse; each one only ever HIDES.
 */

type ForkFlags = { appBlocks?: boolean; appAssistant?: boolean; appBlocksFork?: boolean } | null;

/** The listing fields the Fork gate reads. */
export type ForkableListing = Pick<
  ListingDetail,
  'id' | 'forkable' | 'kind' | 'restrictedAudience'
>;

/**
 * Whether to offer Fork on `listing` to this viewer: signed in, with App Assistant and the
 * `app-blocks-fork` rollout flag, on an on-site listing whose author opted in and that is visible
 * to everyone (no restricted audience — the server requires a PUBLICLY visible parent).
 */
export function canOfferFork(
  features: ForkFlags | undefined,
  listing: ForkableListing | null | undefined,
  signedIn: boolean
): boolean {
  return (
    signedIn &&
    !!features &&
    canAccessAppAssistant(features) &&
    !!features.appBlocksFork &&
    !!listing &&
    listing.forkable === true &&
    listing.kind === 'onsite' &&
    listing.restrictedAudience == null
  );
}

/**
 * Which app hosts offer Fork in the ⋮ menu. Only where the PUBLISHED app is what runs: the dev
 * tunnel runs the author's unpublished code and the review preview a pending version under
 * moderation; a private run is a delisted or suspended app, which is not publicly visible. A
 * total `Record`, so a new host surface is a compile error here until someone decides.
 */
export const FORK_HOST_SURFACES: Record<BlockHostSurface, boolean> = {
  'model-slot': true,
  'page-run': true,
  'private-run': false,
  'dev-tunnel': false,
  'review-preview': false,
};

/** The App Assistant URL for a fork. */
export function forkAssistantHref(forkSlug: string): string {
  return `/apps/assistant?${FORK_QUERY_PARAM}=${encodeURIComponent(forkSlug)}`;
}

/** Start a fork of a listing and open App Assistant on it. */
export function useStartFork() {
  const router = useRouter();
  const mutation = trpc.appListings.startFork.useMutation({
    onSuccess: ({ forkSlug }) => void router.push(forkAssistantHref(forkSlug)),
    onError: (error) =>
      showErrorNotification({ title: 'Couldn’t fork this app', error: { message: error.message } }),
  });
  return {
    start: (listingId: string) => mutation.mutate({ listingId }),
    isPending: mutation.isPending,
  };
}

/** The viewer-side half of the gate, read the same way on both surfaces. */
export function useForkGate(listing: ForkableListing | null | undefined): boolean {
  const features = useOptionalFeatureFlags();
  const user = useCurrentUser();
  return canOfferFork(features, listing, !!user);
}

/** The Fork button in a store page's "Use this app" card. Renders nothing unless offered. */
export function ListingForkButton({ listing }: { listing: ForkableListing }) {
  const offered = useForkGate(listing);
  if (!offered) return null;
  return <ListingForkButtonBody listingId={listing.id} />;
}

function ListingForkButtonBody({ listingId }: { listingId: string }) {
  const fork = useStartFork();
  return (
    <Button
      variant="default"
      fullWidth
      mt="xs"
      leftSection={<IconGitFork size={16} />}
      loading={fork.isPending}
      onClick={() => fork.start(listingId)}
      data-testid="apps-listing-fork"
    >
      {FORK_ACTION_LABEL}
    </Button>
  );
}
