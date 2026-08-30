import { Text } from '@mantine/core';
import { useState } from 'react';

import { ReasonGatedActionModal } from '~/components/Apps/ReasonGatedActionModal';
import {
  TAKEDOWN_TESTID_STEM,
  detailModActionLabel,
  takedownConsequenceCopy,
  takedownSubmitLabel,
  takedownSuccessMessage,
  type DetailTakedownAction,
} from '~/components/Apps/appListingDetailModActions';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * MODERATOR takedown of an APPROVED listing, from the store detail page — the confirm
 * step for both takedown actions the `⋮` menu offers:
 *
 *   - `hide` → `appListings.delistListing` (approved → removed). ONE proc for both
 *     kinds; it flips the backing app block itself when the listing is on-site.
 *   - `reset-to-pending` → `appListings.resetListingToPending` (off-site) /
 *     `resetOnsiteListingToPending` (on-site). TWO procs, routed by kind.
 *
 * ## Why one component for both rather than one per action
 *
 * They differ in exactly two places — which mutation fires, and what the confirm says —
 * and are identical everywhere else: the same single `reason` field at the same
 * `OFFSITE_MOD_REASON_MIN` floor, the same required-reason semantics, the same
 * invalidate-and-blank success posture. That is the shape `ReasonGatedActionModal`
 * exists for, and it is what the /apps/review management table already does: ONE shared
 * `ListingModActionModal` for reset / hide / relist / claim / purge. Two near-identical
 * components would be two places for the copy contrast to drift out of step.
 *
 * ## Why the confirm is reason-gated rather than a plain "are you sure"
 *
 * Every proc here takes a REQUIRED `reason` (`requireModReason`, floor
 * `OFFSITE_MOD_REASON_MIN`), writes it into its audit event, AND delivers it to the owner
 * in the notification. The reason is not a confirmation ritual — it is the message the
 * developer receives explaining why their app came down.
 *
 * ## What it deliberately does NOT offer
 *
 * 🔴 NO `reportId`. `delistListingSchema` accepts an optional `reportId` and resolves that
 * report in the same transaction — but this surface has no report in hand. `ListingDetail`
 * carries no report field of any kind and `/apps/store-preview/<slug>` fetches only
 * `appListings.getAppDetail`, so there is nothing to link. Inventing a report picker here
 * would be building a second reports surface inside a store page; the report queue is
 * where a report-driven delist belongs, and it already passes the id.
 *
 * Mirrors `MessageAppOwnerModal`'s contract: a `listing` prop that is `null` when closed,
 * so the caller holds one nullable piece of state rather than a boolean per action.
 */
export function ListingTakedownModal({
  action,
  listing,
  onClose,
}: {
  /** Which takedown this confirm is for — selects both the mutation and the copy. */
  action: DetailTakedownAction;
  /**
   * The listing to take down, or `null` when closed.
   *
   * `appListingId` must be an `apl_<ULID>` — an `AppListing` id. Every proc here
   * classifies by that id and answers NOT_FOUND for anything else, so a caller that can
   * only supply a publish-REQUEST id (the shadow-preview fallback builder can) must not
   * mount this at all. `kind` selects the reset proc; `slug` is display only.
   */
  listing: { appListingId: string; slug: string; kind: string } | null;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const utils = trpc.useUtils();

  // 🔴 The success handler INVALIDATES the detail read, and that blanks the page the
  // moderator is standing on — deliberately, for BOTH actions. `getAppDetail` is
  // approved-only, so once either lands the listing genuinely is not in the store any
  // more and the route renders its NotFound. Leaving the approved-looking page on screen
  // would be the surface asserting something that stopped being true when the mutation
  // returned.
  const onSuccess = async () => {
    showSuccessNotification({ message: takedownSuccessMessage(action) });
    setReason('');
    await utils.appListings.getAppDetail.invalidate();
    onClose();
  };
  // The composed reason is NOT cleared on failure and the modal stays open: every typed
  // failure here is retryable (NOT_TRANSITIONABLE means someone else moved the listing
  // first; an infra error means try again), so discarding the text the moderator wrote
  // would destroy work they are being asked to reuse.
  const onError = (e: { message: string }) =>
    showErrorNotification({ title: 'Action failed', error: new Error(e.message) });

  const delist = trpc.appListings.delistListing.useMutation({ onSuccess, onError });
  const resetOffsite = trpc.appListings.resetListingToPending.useMutation({ onSuccess, onError });
  const resetOnsite = trpc.appListings.resetOnsiteListingToPending.useMutation({
    onSuccess,
    onError,
  });

  // 🔴 THE ROUTING, AND IT IS TWO DIFFERENT SHAPES ON PURPOSE.
  //
  // `delistListing` is DUAL-KIND in ONE proc: it classifies the listing itself and, for an
  // on-site one, suspends the backing block in the same transaction. So `hide` must NOT be
  // kind-branched here — doing so would imply a second delist proc that does not exist.
  //
  // The reset pair IS kind-branched, because on-site and off-site re-queue through
  // different tables behind two procs and each answers NOT_FOUND for the other kind — a
  // mis-route is a flat failure on a live listing, not a degraded outcome. The
  // non-`'onsite'` case defaults to the off-site proc, matching every other client kind
  // branch in this feature, so an unexpected kind cannot silently take the on-site path.
  const mutation =
    action === 'hide' ? delist : listing?.kind === 'onsite' ? resetOnsite : resetOffsite;
  const busy = delist.isPending || resetOnsite.isPending || resetOffsite.isPending;

  if (!listing) return null;

  function cancel() {
    if (busy) return;
    setReason('');
    onClose();
  }

  const stem = TAKEDOWN_TESTID_STEM[action];
  return (
    <ReasonGatedActionModal
      opened
      onCancel={cancel}
      title={
        <Text fw={600}>
          {detailModActionLabel(action)} — {listing.slug}
        </Text>
      }
      busy={busy}
      reason={reason}
      onReasonChange={setReason}
      // Not because anything is deleted — nothing is — but because the shell's
      // `destructive` slot is what renders the consequences ABOVE the reason field, and
      // both actions stop an on-site app serving. No typed-slug confirm (`confirmSlug` is
      // omitted): that is the `purge` affordance, and borrowing it here would equate a
      // reversible takedown with an irreversible delete.
      destructive
      destructiveWarning={
        <Text size="sm" data-testid={`${stem}-consequences`}>
          {takedownConsequenceCopy(action, listing.kind)}
        </Text>
      }
      reasonLabel="Reason (sent to the owner and recorded in the audit trail)"
      reasonPlaceholder="What is wrong, and what has to change before it can go back up."
      reasonTestId={`${stem}-reason`}
      submitLabel={takedownSubmitLabel(action)}
      submitTestId={`${stem}-submit`}
      onSubmit={() => mutation.mutate({ appListingId: listing.appListingId, reason: reason.trim() })}
    />
  );
}
