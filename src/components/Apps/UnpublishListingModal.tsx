import { Text } from '@mantine/core';
import { useState } from 'react';

import { ReasonGatedActionModal } from '~/components/Apps/ReasonGatedActionModal';
import { unpublishConsequenceCopy } from '~/components/Apps/appListingDetailModActions';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * MODERATOR unpublish of an APPROVED listing, from the store detail page — the confirm
 * step for `appListings.resetListingToPending` / `resetOnsiteListingToPending`.
 *
 * ## Why a component rather than a `ReasonGatedActionModal` inline in the caller
 *
 * The action is DUAL-KIND across two procs with two different mechanics, so the kind
 * routing, the two mutations and the consequence copy belong in one place. The mod
 * management table routes the same pair by kind at its own call site; a second
 * open-coded copy of that branch is how the two surfaces would come to disagree about
 * which proc an on-site listing gets. Here the branch is a single expression (see the
 * note on `mutation` below) and the copy comes from `unpublishConsequenceCopy`, which
 * is pure and pinned in the blocking unit tier.
 *
 * ## Why the confirm is reason-gated rather than a plain "are you sure"
 *
 * Both procs take a REQUIRED `reason` (`modReason`, floor `OFFSITE_MOD_REASON_MIN`),
 * write it into the `reset-to-pending` audit event, AND deliver it to the owner in the
 * notification. So the reason is not a confirmation ritual — it is the message the
 * developer receives explaining why their app came down. `ReasonGatedActionModal` is
 * the shared shell for exactly that.
 *
 * ## Why it is marked `destructive`
 *
 * Not because anything is deleted — nothing is — but because the shell's `destructive`
 * slot is what renders a warning ABOVE the reason field, and this action stops an
 * on-site app serving and cannot be undone from the page that offers it. No typed-slug
 * confirm (`confirmSlug` is omitted): that is the `purge` affordance, and borrowing it
 * here would equate a reversible-by-approval takedown with an irreversible delete.
 *
 * Mirrors `MessageAppOwnerModal`'s contract: a `listing` prop that is `null` when
 * closed, so the caller holds one nullable piece of state rather than a boolean plus a
 * row, and the modal owns its own field state and reset.
 */
export function UnpublishListingModal({
  listing,
  onClose,
}: {
  /**
   * The listing to unpublish, or `null` when closed.
   *
   * `appListingId` must be an `apl_<ULID>` — an `AppListing` id. Both procs classify by
   * that id and answer NOT_FOUND for anything else, so a caller that can only supply a
   * publish-REQUEST id (the shadow-preview fallback builder can) must not mount this at
   * all. `kind` selects the proc; `slug` is display only.
   */
  listing: { appListingId: string; slug: string; kind: string } | null;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const utils = trpc.useUtils();

  // 🔴 The success handler INVALIDATES the detail read, and that blanks the page the
  // moderator is standing on — deliberately. `getAppDetail` is approved-only, so once
  // this lands the listing genuinely is not in the store any more and the route renders
  // its NotFound. Leaving the approved-looking page on screen would be the surface
  // asserting something that stopped being true when the mutation returned.
  const onSuccess = async () => {
    showSuccessNotification({
      message:
        'App unpublished and re-queued for review. Approve the queued request in the review queue to put it back up.',
    });
    setReason('');
    await utils.appListings.getAppDetail.invalidate();
    onClose();
  };
  // The composed reason is NOT cleared on failure and the modal stays open: every typed
  // failure here is retryable (NOT_TRANSITIONABLE means someone else moved the listing
  // first; an infra error means try again), so discarding the text the moderator wrote
  // would destroy work they are being asked to reuse.
  const onError = (e: { message: string }) =>
    showErrorNotification({ title: 'Unpublish failed', error: new Error(e.message) });

  const offsite = trpc.appListings.resetListingToPending.useMutation({ onSuccess, onError });
  const onsite = trpc.appListings.resetOnsiteListingToPending.useMutation({ onSuccess, onError });

  // 🔴 THE KIND ROUTING. On-site and off-site re-queue through different tables
  // (`app_block_publish_requests` vs `AppListingPublishRequest`) behind two procs, and
  // each answers NOT_FOUND for the other kind — so a mis-route is not a degraded outcome,
  // it is a flat failure on a live listing. The non-`'onsite'` case defaults to the
  // off-site proc, matching every other client kind branch in this feature, so an
  // unexpected kind cannot silently take the on-site path that suspends a block.
  const mutation = listing?.kind === 'onsite' ? onsite : offsite;
  const busy = onsite.isPending || offsite.isPending;

  if (!listing) return null;

  function cancel() {
    if (busy) return;
    setReason('');
    onClose();
  }

  return (
    <ReasonGatedActionModal
      opened
      onCancel={cancel}
      title={<Text fw={600}>Unpublish {listing.slug}</Text>}
      busy={busy}
      reason={reason}
      onReasonChange={setReason}
      destructive
      destructiveWarning={
        <Text size="sm" data-testid="apps-listing-unpublish-consequences">
          {unpublishConsequenceCopy(listing.kind)}
        </Text>
      }
      reasonLabel="Reason (sent to the owner and recorded in the audit trail)"
      reasonPlaceholder="What is wrong, and what has to change before it can go back up."
      reasonTestId="apps-listing-unpublish-reason"
      submitLabel="Unpublish"
      submitTestId="apps-listing-unpublish-submit"
      onSubmit={() => mutation.mutate({ appListingId: listing.appListingId, reason: reason.trim() })}
    />
  );
}
