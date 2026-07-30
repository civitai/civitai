import { Alert, Button, Center, Group, Loader, Stack, Text } from '@mantine/core';
import { IconInfoCircle, IconSend } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ListingAssetStep } from '~/components/Apps/ListingAssetStep';
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
 * FORBIDDEN (non-owner) / NOT_FOUND (no listing) → this renders NotFound. All asset
 * edits target a SHADOW revision (mod re-review) so the live listing keeps serving.
 *
 * NOTE: the "Back to app" affordance lives on the OWNING page (so the tabbed /edit
 * page has a single back control), not here.
 */
export function ListingMediaEditor({ appBlockId }: { appBlockId: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();

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

  const listingId = listing?.appListingId;

  // 2) Begin (or resume) the editable shadow revision — idempotent, and it returns
  //    the SAME shadow `getMyListingForApp` already resolved server-side (a parent
  //    has at most one in-flight shadow), so `listing.assets` below always describes
  //    exactly this id. Kept as the render gate + the error surface for a listing
  //    that isn't revisable (a non-approved parent → "only an approved listing can
  //    be revised"). Every asset mutation the step performs targets the shadow,
  //    never the live parent.
  const [shadowId, setShadowId] = useState<string | null>(null);
  const [beginError, setBeginError] = useState<string | null>(null);
  const beginRevision = trpc.appListings.beginListingRevision.useMutation();
  useEffect(() => {
    if (!listingId || shadowId || beginRevision.isPending) return;
    beginRevision.mutate(
      { listingId },
      {
        onSuccess: (res) => setShadowId(res.shadowId),
        onError: (e) => setBeginError(e.message),
      }
    );
    // Fire once per resolved listing id; the mutation object identity is stable enough
    // and re-adding it would loop on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingId]);

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

  // 4) Submit the prepared shadow for moderator re-approval.
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
  // 🔴 Anything ELSE must NOT collapse the page. `getMyListingForApp` now resolves the
  // shadow server-side, so a `beginListingRevision` failure surfaces HERE — and those
  // are BAD_REQUEST (`INVALID_REVISION`: "cannot edit a listing in status …", "failed to
  // open a revision draft"). Blanket-NotFound'ing them made the inline alert below —
  // which exists precisely to explain them — unreachable, and told the owner their live
  // app didn't exist. Narrow the guard so everything else falls through to that alert.
  const listingErrorCode = (listingError as { data?: { code?: string } } | null | undefined)?.data
    ?.code;
  if (listingError && (listingErrorCode === 'FORBIDDEN' || listingErrorCode === 'NOT_FOUND'))
    return <NotFound />;

  // The begin-revision failure and the (non-fatal) listing-resolve failure share one
  // actionable surface.
  const inlineError = beginError ?? (listingError ? listingError.message : null);

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
      {listing && !listingError && (
        <Alert
          icon={<IconInfoCircle size={16} />}
          color="blue"
          variant="light"
          title="Listing images"
          data-testid="apps-listing-media-live-notice"
        >
          <Text size="sm">
            This app is <b>live</b> — your image changes are staged as a revision and go live only
            after a moderator re-approves. Update the icon, cover and screenshots below, then submit
            for review. Media can be added while it is still scanning; it only goes live once its
            scan finishes cleanly.
          </Text>
        </Alert>
      )}

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

      {listingLoading || !listing ? (
        // A settled error is terminal — don't spin forever underneath the alert.
        inlineError ? null : (
          <Center py="xl">
            <Loader />
          </Center>
        )
      ) : !shadowId ? (
        <Group gap={8} data-testid="apps-listing-media-preparing">
          <Loader size={16} />
          <Text size="sm" c="dimmed">
            Preparing your revision…
          </Text>
        </Group>
      ) : (
        <Stack gap="md">
          <div data-testid="apps-listing-media-assets-panel">
            <ListingAssetStep
              listingId={shadowId}
              contentRating={listing.contentRating as OffsiteContentRating}
              suggestions={{}}
              // 🔴 Prefill from the SHADOW's assets (what `getMyListingForApp`
              // projects). Without this the step seeded every slot empty, so it
              // rendered "Icon none / Cover none" for a listing that HAS both and
              // its publish floor (icon+cover attached) could never be met —
              // "Submit for review" was permanently disabled and the flow could
              // not be completed by anyone. The step reads `initial` in its
              // useState initialisers, and it only mounts once `shadowId` resolves
              // (the query that carries the assets has long settled by then), so
              // there is no seed race.
              initial={listing.assets}
              allowRemove
              onAssetMutated={handleAssetMutated}
              onCompletenessChange={handleCompletenessChange}
            />
          </div>
          <Group justify="flex-end">
            <Button
              onClick={() => void handleSubmit()}
              loading={submitRevision.isPending}
              disabled={!meetsFloor}
              leftSection={<IconSend size={16} />}
              data-testid="apps-listing-media-submit"
            >
              Submit for review
            </Button>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}
