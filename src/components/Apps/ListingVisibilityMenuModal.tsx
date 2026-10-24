import { Center, Loader, Modal, Text } from '@mantine/core';

import { ListingVisibilityModal } from '~/components/Apps/ListingVisibilityModal';
import { ownerVisibilityLoadState } from '~/components/Apps/listingPublishingActions';
import { trpc } from '~/utils/trpc';

/**
 * The owner's VISIBILITY LEVEL picker as opened from the store `⋮` menu
 * (`AppListingActionsMenu`, on both the card and the detail page).
 *
 * 🔴 IT FETCHES ITS OWN INPUTS, AND ONLY WHILE OPEN. `ListingVisibilityModal` needs the
 * listing's `status`, stored level and `visibilityAvailable`; the public card/detail DTOs
 * carry none of them, and adding the level there would publish an owner-only setting to
 * every viewer. So this reads `appListings.getAuthoringContext` — the owner-scoped read the
 * edit page's Publishing tab is fed from — with `enabled: opened`. The store grid mounts
 * this per owned card once its menu has been opened, and nothing is requested until the
 * item is clicked.
 *
 * Eligibility is decided on the FETCHED row by `ownerVisibilityLoadState`, i.e. by
 * `showVisibility`, so the menu never offers the picker on a listing the Publishing tab
 * would not. The picker itself is the existing component, unchanged; it invalidates
 * `getAuthoringContext` on save, so a reopen shows the new level.
 */
export function ListingVisibilityMenuModal({
  listing,
  opened,
  onClose,
}: {
  listing: { id: string; slug: string };
  opened: boolean;
  onClose: () => void;
}) {
  const { data, isError } = trpc.appListings.getAuthoringContext.useQuery(
    { appListingId: listing.id },
    // `retry: false` matches the edit page: FORBIDDEN / NOT_FOUND are answers, not blips.
    { enabled: opened, retry: false }
  );

  if (!opened) return null;

  const state = ownerVisibilityLoadState({ isError, context: data });

  if (state === 'ready' && data) {
    return (
      <ListingVisibilityModal
        target={listing}
        status={data.status}
        currentVisibility={data.visibility}
        available={data.visibilityAvailable}
        onClose={onClose}
        // Nothing on the card or detail page renders the level, so there is nothing to
        // refresh here beyond what the picker already invalidates.
        onDone={() => undefined}
        testIdPrefix="apps-listing-owner"
      />
    );
  }

  return (
    <Modal opened onClose={onClose} title={<Text fw={600}>Visibility</Text>} centered>
      {state === 'loading' ? (
        <Center py="md" data-testid="apps-listing-owner-visibility-loading">
          <Loader size="sm" />
        </Center>
      ) : (
        <Text size="sm" data-testid="apps-listing-owner-visibility-unavailable">
          {state === 'ineligible'
            ? 'The visibility level cannot be changed for this listing in its current state.'
            : 'Could not load this listing’s visibility settings. Try again later.'}
        </Text>
      )}
    </Modal>
  );
}
