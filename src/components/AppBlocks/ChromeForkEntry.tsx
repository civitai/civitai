import { IconGitFork } from '@tabler/icons-react';

import { FORK_HOST_SURFACES, useForkGate, useStartFork } from '~/components/Apps/ForkAppAction';
import { FORK_ACTION_LABEL } from '~/shared/constants/app-fork.constants';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { canAccessAppAssistant } from '~/shared/utils/app-blocks-access';
import type { BlockHostSurface } from './blockInitFragmentGate';
import { ChromeSurfaceItem } from './ChromeSurface';
import { useChromeListingDetail } from './useChromeListingDetail';

/**
 * FORKABLE APPS — "Fork" in the running app's ⋮ menu.
 *
 * Same lazy shape as `ChromeReviewMenuItem`: the cheap synchronous gates (a slug, a host surface
 * that offers Fork, App Assistant and the rollout flag) decide whether the query-bearing half
 * mounts at all, and that half reads the listing through the chrome's ONE listing read
 * (`useChromeListingDetail`), which Mantine only mounts while the menu is open. Hidden on the dev
 * tunnel and the review preview (`FORK_HOST_SURFACES`).
 */
export function ChromeForkMenuItem({
  slug,
  hostSurface,
}: {
  /** The app's STORE slug. Omitted → no entry point. */
  slug: string | undefined;
  hostSurface: BlockHostSurface | undefined;
}) {
  const features = useOptionalFeatureFlags();
  if (
    !slug ||
    !hostSurface ||
    !FORK_HOST_SURFACES[hostSurface] ||
    !features ||
    !canAccessAppAssistant(features) ||
    !features.appBlocksFork
  )
    return null;
  return <ChromeForkMenuItemBody slug={slug} />;
}

function ChromeForkMenuItemBody({ slug }: { slug: string }) {
  const { detail } = useChromeListingDetail(slug);
  const offered = useForkGate(detail);
  if (!detail || !offered) return null;
  return <ChromeForkMenuItemAction listingId={detail.id} />;
}

function ChromeForkMenuItemAction({ listingId }: { listingId: string }) {
  const fork = useStartFork();
  return (
    <ChromeSurfaceItem
      leftSection={<IconGitFork size={14} stroke={1.5} />}
      onClick={() => {
        if (!fork.isPending) fork.start(listingId);
      }}
      data-testid="app-block-fork-menu-item"
    >
      {FORK_ACTION_LABEL}
    </ChromeSurfaceItem>
  );
}
