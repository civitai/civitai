import { Alert, Anchor, Button, Center, Container, Group, Loader, Stack, Text } from '@mantine/core';
import { IconArrowLeft, IconInfoCircle, IconSend } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ListingAssetStep } from '~/components/Apps/ListingAssetStep';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { OffsiteContentRating } from '~/server/schema/blocks/offsite-listing.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * On-site listing media (owner) — the owner-facing icon / cover / screenshot editor
 * for a LIVE on-site app at `/apps/<appBlockId>/listing`.
 *
 * Gating mirrors `edit-manifest.tsx`: the SSR resolver enforces the appBlocks flag
 * + a logged-in session (anon → /login). The OWNER check is single-sourced at the
 * tRPC layer — `appListings.getMyListingForApp` throws FORBIDDEN (non-owner) /
 * NOT_FOUND (no listing) — so a non-owner / missing listing settles to NotFound.
 *
 * Flow (assets-only; name/description/URL/rating stay in the manifest editor):
 *   1. Resolve `appBlockId` → `appListingId` via `getMyListingForApp`.
 *   2. `beginListingRevision({ listingId })` (idempotent — resumes an in-flight
 *      shadow) to get the editable SHADOW id. All asset edits target the shadow, so
 *      the live listing keeps serving until a moderator re-approves.
 *   3. Render `<ListingAssetStep listingId={shadowId} …/>` (reused verbatim — each
 *      icon/cover/screenshot mutation hits the shadow eagerly through the standard
 *      Image ingestion + NSFW scan).
 *   4. "Submit for review" → `submitListingRevision({ shadowId })`.
 *
 * 🔴 HONEST FRAMING: the app is live, so image changes are staged as a revision and
 * go live only after a moderator re-approves — surfaced up-front (+ a pending-review
 * notice when a revision is already queued). Consolidation of an approved revision
 * to live is handled server-side by the sibling onsite-consolidation change.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.appBlocks) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: { destination: getLoginLink({ returnUrl: ctx.resolvedUrl }), permanent: false },
      };
    }
    return { props: {} };
  },
});

export default function ListingMediaPage() {
  const features = useFeatureFlags();
  const router = useRouter();
  const utils = trpc.useUtils();
  const appBlockId = typeof router.query.appBlockId === 'string' ? router.query.appBlockId : '';

  // 1) Owner-gated resolve of the backing listing id for this app block. A non-owner
  //    (FORBIDDEN) or a missing listing (NOT_FOUND) both settle to NotFound (retry:false).
  const {
    data: listing,
    isLoading: listingLoading,
    error: listingError,
  } = trpc.appListings.getMyListingForApp.useQuery(
    { appBlockId },
    { enabled: !!features.appBlocks && !!appBlockId, retry: false }
  );

  const listingId = listing?.appListingId;

  // 2) Begin (or resume) the editable shadow revision — idempotent. Every asset
  //    mutation the step performs targets the shadow, never the live parent.
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

  if (!features.appBlocks) return <NotFound />;
  // FORBIDDEN (non-owner) / NOT_FOUND (no listing) both settle to NotFound.
  if (listingError) return <NotFound />;

  return (
    <>
      <Meta title="Listing images — Civitai Apps" deIndex />
      <Container size="sm" py="md">
        <Stack gap="lg">
          <Anchor component={Link} href={`/apps/${appBlockId}`} size="sm">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              Back to app
            </Group>
          </Anchor>

          {/* 🔴 Honest, up-front framing — mirrors ExternalListingEditForm's live-app notice. */}
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
              submit for review.
            </Text>
          </Alert>

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

          {beginError && (
            <Alert color="red" variant="light" data-testid="apps-listing-media-begin-error">
              <Text size="sm">{beginError}</Text>
            </Alert>
          )}

          {listingLoading || !listing ? (
            <Center py="xl">
              <Loader />
            </Center>
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
                  allowRemove
                />
              </div>
              <Group justify="flex-end">
                <Button
                  onClick={() => void handleSubmit()}
                  loading={submitRevision.isPending}
                  leftSection={<IconSend size={16} />}
                  data-testid="apps-listing-media-submit"
                >
                  Submit for review
                </Button>
              </Group>
            </Stack>
          )}
        </Stack>
      </Container>
    </>
  );
}
