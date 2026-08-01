import { Alert, Button, Center, Group, Loader, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle, IconSend } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ListingAssetStep } from '~/components/Apps/ListingAssetStep';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { OffsiteContentRating } from '~/server/schema/blocks/offsite-listing.schema';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * On-site listing MEDIA editor (owner) — the icon / cover / screenshot editor body
 * for a LIVE on-site app, extracted from the former standalone
 * `/apps/[appBlockId]/listing` page so it can be embedded as the "Listing media" tab
 * of the unified `/apps/[appBlockId]/edit` page (and reused anywhere else).
 *
 * Owner gating is single-sourced at the tRPC layer: `getMyListingForApp` throws
 * NOT_OWNED→FORBIDDEN (non-owner) / NOT_FOUND (no listing) → this renders NotFound.
 * 🔴 That owner check has NO moderator branch, so this editor is only ever reachable
 * for the caller's OWN listing — including for a moderator (the production incident
 * behind the notice below was an owner-AND-moderator editing their own live apps).
 *
 * 🔴 THREE WRITE SEMANTICS on an APPROVED listing, and the copy MUST match. The
 * discriminator is `isModerator && !shadowId` — NOT `isModerator` alone:
 *   - OWNER (non-mod) → the first asset mutation mints a SHADOW revision server-side;
 *     the live listing keeps serving until a mod re-approves. STAGED.
 *   - MODERATOR, NO shadow yet → `editTargetId` is the live parent, and
 *     `resolveOwnerAssetEditTarget` / `assertOwnerAssetEditable` both short-circuit on
 *     `user.isModerator`, so no shadow is minted and the write lands DIRECTLY on the
 *     live listing (the deliberate curation bypass). IMMEDIATE.
 *   - MODERATOR, shadow ALREADY exists → 🔴 STAGED, same as an owner.
 *     `getMyListingForApp` resolves `editTargetId` to an existing shadow with no
 *     moderator branch of its own, so the asset step is hosted against the SHADOW's id
 *     — and `resolveOwnerAssetEditTarget` returns its target UNCHANGED for a moderator
 *     (`if (user.isModerator) return listing;` is the first line; the `revisionOfId`
 *     check below it is never reached for a mod, and describes the OWNER branch). Here
 *     "unchanged" means the shadow, so the write applies to the shadow and only goes
 *     live on re-approval. Gating the "applies immediately" copy on `isModerator`
 *     alone lies to exactly this case.
 *
 *     🔴 HOW OFTEN this state occurs is UNMEASURED — and the gate's correctness does
 *     not depend on it, which is the only reason not to go measure it. Do NOT justify
 *     this branch with the 78%-of-approved-parents-carry-a-shadow figure in the note
 *     below: that counted the PRE-fix prevalence manufactured by the write-on-view bug
 *     lazy creation removed, under preconditions that no longer hold. Post-fix a shadow
 *     exists only after a real owner edit, and a moderator's own asset edits never mint
 *     one — so the rate could be near zero, or still high if those legacy never-edited
 *     shadows were never purged (no cleanup migration is known to have run). Citing a
 *     measurement taken under different preconditions is the exact error that produced
 *     the first, wrong version of this gate. If you need the number, go count it.
 *
 * NOTE: the "Back to app" affordance lives on the OWNING page (so the tabbed /edit
 * page has a single back control), not here.
 */
export function ListingMediaEditor({ appBlockId }: { appBlockId: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const currentUser = useCurrentUser();
  // Read from the session hook (the established client idiom, e.g.
  // `ExternalSubmitForm`) rather than threaded as a prop, so every host of this
  // editor is correct by default. NOT sufficient on its own as the copy
  // discriminator — see `modDirectLiveEdit` below.
  const isModerator = !!currentUser?.isModerator;

  // 1) Owner-gated resolve of the backing listing id for this app block. A non-owner
  //    (FORBIDDEN) or a missing listing (NOT_FOUND) both settle to NotFound.
  const {
    data: listing,
    isLoading: listingLoading,
    error: listingError,
  } = trpc.appListings.getMyListingForApp.useQuery(
    { appBlockId },
    { enabled: !!appBlockId, retry: false }
  );

  // 2) The asset step's target, resolved server-side WITHOUT writing anything:
  //    the in-flight shadow revision when one exists, else the listing itself.
  //
  //    🔴 NO `beginListingRevision` on mount. Firing it here made merely OPENING this
  //    tab create a `draft` AppListing — 78% of approved onsite parents on prod carried
  //    a shadow that represented no edit, three of them minted 1.5 s apart by opening
  //    three apps in a row, and they self-refilled the moment anyone looked. The shadow
  //    is now minted by the FIRST asset mutation, server-side, inside the asset procs
  //    (which also re-key any parent screenshot row id onto the fresh clone). The
  //    "isn't revisable" error this call used to surface (`removed` / `rejected` /
  //    an internal shadow) now arrives on the read as `editBlockedReason`.
  const editTargetId = listing?.editTargetId ?? null;
  const shadowId = listing?.shadowId ?? null;
  const editBlockedReason = listing?.editBlockedReason ?? null;
  const isApproved = listing?.status === 'approved';

  // 🔴 THE ONE DISCRIMINATOR for "this edit goes live immediately" — see the header.
  // `!shadowId` is what makes it correct: it is exactly `editTargetId === appListingId`
  // (the server sets `shadowId` and redirects `editTargetId` together, or neither), so
  // it says "the asset step is hosted against the LIVE parent". A moderator whose
  // listing already carries a shadow is editing that shadow and IS staged — they must
  // get the owner copy. `isModerator` alone would tell them the opposite.
  //
  // Deliberately NOT `&& isApproved`: both consumers already sit inside an `isApproved`
  // gate, so the conjunct flipped no state while making the expression read as a
  // different rule from the one the comments state. Keep this identical to the header's
  // `isModerator && !shadowId`. 🔴 If you ever consume it OUTSIDE an `isApproved` gate,
  // add the approval check THERE — a draft/pending listing has no shadow, so this alone
  // would be true for a moderator on one.
  const modDirectLiveEdit = isModerator && !shadowId;

  // 3) Re-pull the projected assets after EVERY successful asset mutation.
  //
  // 🔴 The step seeds icon/cover/screenshots in `useState` INITIALISERS only, and the
  // owning /edit page mounts its tabs with `keepMounted={false}` — so media→manifest→
  // media UNMOUNTS and REMOUNTS this editor. The query is `staleTime: Infinity` +
  // `refetchOnWindowFocus: false`, so without an invalidation here the remount re-seeds
  // from the ORIGINAL cached `assets`: a just-attached icon reads as unattached (Submit
  // disabled again — the exact symptom this component exists to fix) and a removed
  // screenshot's stale row id can be "removed" a second time → server error. Only
  // `handleSubmit` invalidated before. Invalidating (rather than re-keying the step on
  // shadowId+version) refreshes the cache WITHOUT remounting, so an in-flight upload in
  // the mounted step is never thrown away.
  const handleAssetMutated = useCallback(() => {
    void utils.appListings.getMyListingForApp.invalidate({ appBlockId });
  }, [utils, appBlockId]);

  // Track the asset floor so the submit button matches the server floor gate
  // (icon+cover required; screenshots optional). Submit is deliberately NOT gated on
  // scan completion — the server go-live scan gate is the safety net.
  const [meetsFloor, setMeetsFloor] = useState(false);
  const handleCompletenessChange = useCallback(
    (state: { meetsFloor: boolean; complete: boolean }) => setMeetsFloor(state.meetsFloor),
    []
  );

  // 4) Submit the prepared shadow for moderator re-approval. Only reachable once a
  //    shadow EXISTS — i.e. once the owner has actually changed something. With no
  //    edits there is nothing to review (and no shadow id to submit).
  const submitRevision = trpc.appListings.submitListingRevision.useMutation();
  async function handleSubmit() {
    if (!shadowId) return;
    try {
      await submitRevision.mutateAsync({ shadowId });
      await utils.appListings.getMyListingForApp.invalidate({ appBlockId });
      showSuccessNotification({
        title: 'Sent for review',
        message: 'Your image changes go live once a moderator re-approves them.',
      });
      void router.push('/apps/my-submissions');
    } catch (e) {
      const message = (e as { message?: string }).message ?? 'Failed to submit for review.';
      showErrorNotification({ title: 'Could not submit', error: new Error(message) });
    }
  }

  // FORBIDDEN (non-owner) / NOT_FOUND (no listing) are the genuine "this isn't yours /
  // doesn't exist" cases → NotFound.
  //
  // 🔴 Anything ELSE must NOT collapse the page — a BAD_REQUEST from the resolve, or an
  // INTERNAL_SERVER_ERROR, belongs in the inline alert below (which exists precisely to
  // explain them). Blanket-NotFound'ing them made that alert unreachable and told the
  // owner their live app didn't exist. Narrow the guard so everything else falls through.
  const listingErrorCode = (listingError as { data?: { code?: string } } | null | undefined)?.data
    ?.code;
  if (listingError && (listingErrorCode === 'FORBIDDEN' || listingErrorCode === 'NOT_FOUND'))
    return <NotFound />;

  // The "this listing can't be edited at all" verdict (`removed` / `rejected` / an
  // internal shadow — previously delivered as the on-mount `beginListingRevision`'s
  // INVALID_REVISION) and the (non-fatal) listing-resolve failure share one actionable
  // surface. Either one keeps the editor unmounted.
  const inlineError = editBlockedReason ?? (listingError ? listingError.message : null);

  return (
    <Stack gap="lg">
      {/* 🔴 Honest, up-front framing — mirrors ExternalListingEditForm's live-app notice.
          Gated on a RESOLVED listing: it asserts "this app is live" and describes an
          editor that is about to render. When the resolve settled to an error (a
          `removed` listing, an INTERNAL_SERVER_ERROR, a client error with no
          `data.code`) nothing below it renders, so an ungated notice put "This app is
          live" directly above "cannot edit a listing in status removed" — a
          contradictory half-UI where the pre-narrowing code showed a clean NotFound.
          The red alert below still surfaces those non-gating errors (that improvement
          stands); this notice just stops claiming context it doesn't have. */}
      {listing &&
        !listingError &&
        isApproved &&
        !editBlockedReason &&
        (modDirectLiveEdit ? (
          // 🔴 MODERATOR-ON-THE-LIVE-PARENT variant (`isModerator && !shadowId`). The
          // server's curation bypass writes straight to the live listing — no shadow,
          // no re-approval — so this must NOT repeat the owner copy's "staged as a
          // revision" claim. A moderator WITH a shadow falls through to the owner copy
          // below, which is correct for them: that write goes to the shadow. Own testid
          // so a test can tell the variants apart (and so the owner testid keeps
          // meaning "the staged-revision copy").
          <Alert
            icon={<IconAlertTriangle size={16} />}
            color="orange"
            variant="light"
            title="Editing the live listing"
            data-testid="apps-listing-media-mod-live-notice"
          >
            <Text size="sm">
              This app is <b>live</b> and you are editing it as a <b>moderator</b> — your image
              changes are <b>not</b> staged as a revision and need no re-approval. They apply to the
              live listing immediately. Media can be added while it is still scanning; it only
              appears once its scan finishes cleanly.
            </Text>
          </Alert>
        ) : (
          <Alert
            icon={<IconInfoCircle size={16} />}
            color="blue"
            variant="light"
            title="Listing images"
            data-testid="apps-listing-media-live-notice"
          >
            <Text size="sm">
              This app is <b>live</b> — your image changes are staged as a revision and go live only
              after a moderator re-approves. Update the icon, cover and screenshots below, then
              submit for review. Media can be added while it is still scanning; it only goes live
              once its scan finishes cleanly.
            </Text>
          </Alert>
        ))}

      {listing?.hasPendingRevision && (
        <Alert
          color="orange"
          variant="light"
          icon={<IconInfoCircle size={16} />}
          data-testid="apps-listing-media-pending-revision-notice"
        >
          <Text size="sm">
            A revision of this app is already under review. Submitting again updates that pending
            revision.
          </Text>
        </Alert>
      )}

      {inlineError && (
        <Alert color="red" variant="light" data-testid="apps-listing-media-begin-error">
          <Text size="sm">{inlineError}</Text>
        </Alert>
      )}

      {listingLoading || !listing || !editTargetId ? (
        // A settled error is terminal — don't spin forever underneath the alert.
        inlineError ? null : (
          <Center py="xl">
            <Loader />
          </Center>
        )
      ) : editBlockedReason ? null : (
        <Stack gap="md">
          <div data-testid="apps-listing-media-assets-panel">
            <ListingAssetStep
              // The EDIT TARGET: the in-flight shadow when one exists, else the listing
              // itself. For an approved listing with no shadow yet this is the LIVE
              // parent id — and the first mutation against it mints the shadow
              // server-side and applies there, never to the parent.
              listingId={editTargetId}
              contentRating={listing.contentRating as OffsiteContentRating}
              suggestions={{}}
              // 🔴 Prefill from the EDIT TARGET's assets (what `getMyListingForApp`
              // projects). Without this the step seeded every slot empty, so it
              // rendered "Icon none / Cover none" for a listing that HAS both and
              // its publish floor (icon+cover attached) could never be met —
              // "Submit for review" was permanently disabled and the flow could
              // not be completed by anyone. The step reads `initial` in its
              // useState initialisers and only mounts once the query has settled,
              // so there is no seed race.
              //
              // 🔴 Before the first edit these are the PARENT's screenshot ROW ids.
              // That is safe ONLY because every row-id-keyed proc re-keys them onto the
              // freshly-minted shadow's clone server-side, and fails closed if it can't
              // — see `resolveOwnerScreenshotTarget`. Do NOT add a client path that
              // mutates a screenshot row outside those procs.
              initial={listing.assets}
              allowRemove
              onAssetMutated={handleAssetMutated}
              onCompletenessChange={handleCompletenessChange}
            />
          </div>
          {/* 🔴 Same discriminator as the notice above, deliberately. For a moderator
              editing the LIVE parent, no edit will ever mint a shadow, so "Change an
              image to stage a revision" is false and `disabled={… || !shadowId}` makes
              Submit permanently dead — a broken control contradicting the notice four
              lines above it. There is nothing to submit: their change is already live.
              🔴 Do NOT widen this to `isModerator` — a moderator WITH a shadow has a
              real revision that still needs submitting for re-approval. */}
          {isApproved && !modDirectLiveEdit && (
            <Group justify="flex-end" align="center">
              {!shadowId && (
                <Text size="xs" c="dimmed" data-testid="apps-listing-media-no-changes">
                  Change an image to stage a revision.
                </Text>
              )}
              <Button
                onClick={() => void handleSubmit()}
                loading={submitRevision.isPending}
                // No shadow ⇒ nothing has changed ⇒ there is no revision to submit.
                disabled={!meetsFloor || !shadowId}
                leftSection={<IconSend size={16} />}
                data-testid="apps-listing-media-submit"
              >
                Submit for review
              </Button>
            </Group>
          )}
        </Stack>
      )}
    </Stack>
  );
}
