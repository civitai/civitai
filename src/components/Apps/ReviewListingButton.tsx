import { Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconThumbDown, IconThumbUp } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { LISTING_REVIEW_DETAILS_MAX } from '~/server/schema/blocks/app-listing-review.schema';
import { resolveClientStoreScope } from '~/shared/utils/app-blocks-access';
import {
  scopeAdmitsListingKind,
  type StoreListingKind,
} from '~/shared/utils/store-visibility-scope';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * App Store Listings (W13) — the USER "leave a review" affordance (thumbs /
 * recommend + optional blurb) for a store listing. A compact button in the
 * detail action column that opens a modal with the thumbs toggle + a textarea →
 * `appListings.upsertReview`.
 *
 * ELIGIBILITY (mirrors the server gate; the server is the source of truth):
 *   - HIDDEN for a signed-out viewer (`upsertReview` is protected).
 *   - HIDDEN for the listing OWNER — unlike the legacy 5-star path, the public
 *     detail DTO carries the creator id, so we can hide the self-review CTA
 *     client-side (the server still 403s a self-review as defense-in-depth).
 *   - NO install/usage gate (locked W13 decision) — any other signed-in user may
 *     review, for BOTH on-site + off-site kinds.
 *
 * Prefills from `getMyReview` so the SAME modal EDITS an existing review (the
 * backend upserts on (listing, user)); the current recommend state is shown +
 * changeable. DARK: reachable only on the mod-only store-preview surface today.
 *
 * 🔴 SPLIT INTO GATE + MODAL + BUTTON, and the split is structural rather than
 * cosmetic. The listing detail's secondary actions now live in a `⋮` Menu, and a
 * Mantine `Menu.Dropdown` is UNMOUNTED when the menu closes — so a modal rendered as
 * a sibling of a `Menu.Item` trigger would be torn down the instant the item is
 * clicked, i.e. the modal could never open. The trigger has to live inside the
 * dropdown and the modal outside it, which means the `opened` state has to be owned
 * by the caller. Hence:
 *   - {@link useCanReviewListing} — the eligibility gate, in ONE place, so the Button
 *     and the Menu item cannot disagree about who may review.
 *   - {@link ReviewListingModal} — the form + mutation, mountable anywhere.
 *   - {@link ReviewListingButton} — the original standalone affordance, composed from
 *     the two. Its behaviour is unchanged and its own browser suite is the guard.
 */

/**
 * May THIS viewer review THIS listing? Signed-in, not the listing owner, AND holding
 * a store scope that admits the listing's KIND.
 *
 * Mirrors the server gate (`upsertReview` is protected, 403s a self-review, and
 * NOT_FOUNDs a listing the caller's scope hides); the server remains the source of
 * truth and this only decides whether to render an affordance. Extracted so the
 * Button and the detail page's `⋮` menu item read the same predicate instead of each
 * re-deriving it.
 *
 * 🔴 THE `listingKind` TERM CLOSES THE SECOND HALF OF THE SAME DEFECT. The write gate
 * used to be keyed on the `app-listings` flag while the read path had moved to a
 * resolved scope, so the external-only cohort saw this button on an offsite listing
 * and got `UNAUTHORIZED` on submit. Fixing only the server would leave the mirror
 * image live: the same cohort reaching an ONSITE listing (via a store-preview link,
 * a shared URL, a cached page) would still be offered a control the server now
 * correctly refuses. Both directions are the one anti-goal — never show an affordance
 * that will be rejected — so both are gated on the SAME resolved scope and the SAME
 * shared `scopeAdmitsListingKind` rule the server applies.
 *
 * `listingKind` is OPTIONAL and an omitted value SKIPS the kind term (not "assume
 * onsite"): callers that genuinely have no kind in hand must not be silently
 * downgraded to hiding the button for everyone. Every in-product caller passes it —
 * the detail DTO carries `kind` at top level.
 */
export function useCanReviewListing({
  ownerUserId,
  listingKind,
}: {
  ownerUserId: number | null;
  /** The listing's kind. Omit only when genuinely unavailable — the term is skipped. */
  listingKind?: StoreListingKind;
}): boolean {
  const currentUser = useCurrentUser();
  // 🔴 `useOptionalFeatureFlags`, not `useFeatureFlags`: the latter THROWS outside the
  // provider, and this hook runs from a shared predicate rather than from a component
  // that owns its mounting context. Outside the provider the flags read `null`,
  // `resolveClientStoreScope` fails closed to `none`, and the affordance is hidden —
  // the safe direction for a control the server may refuse.
  const features = useOptionalFeatureFlags();
  if (!currentUser) return false;
  if (ownerUserId != null && ownerUserId === currentUser.id) return false;
  if (listingKind && !scopeAdmitsListingKind(resolveClientStoreScope(features), listingKind)) {
    return false;
  }
  return true;
}

/**
 * The review form modal. Renders NO trigger — the caller owns `opened`.
 *
 * 🔴 Applies NO eligibility gate of its own: a caller that mounts this has already
 * decided the viewer may review (via {@link useCanReviewListing}), and duplicating
 * the rule here would put it in two places. The server gate is the real one.
 */
export function ReviewListingModal({
  appListingId,
  opened,
  onClose,
}: {
  appListingId: string;
  opened: boolean;
  onClose: () => void;
}) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const [recommended, setRecommended] = useState<boolean | null>(null);
  const [details, setDetails] = useState('');
  const close = onClose;

  const enabled = !!currentUser && opened;
  const { data: myReview } = trpc.appListings.getMyReview.useQuery(
    { appListingId },
    { enabled }
  );

  // Seed the form from the viewer's existing review once it loads (keyed on the
  // review id so a fresh load reseeds without clobbering in-progress typing).
  useEffect(() => {
    if (myReview) {
      setRecommended(myReview.recommended);
      setDetails(myReview.details ?? '');
    }
  }, [myReview?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const upsert = trpc.appListings.upsertReview.useMutation({
    onSuccess: async (res) => {
      showSuccessNotification({
        message: res.isNewReview ? 'Thanks for your review!' : 'Review updated',
      });
      close();
      await Promise.all([
        queryUtils.appListings.getMyReview.invalidate({ appListingId }),
        queryUtils.appListings.listReviews.invalidate({ appListingId }),
        // The recommend rollup lives on getAppDetail — refresh so the "N% recommend"
        // block reflects the new/changed review.
        queryUtils.appListings.getAppDetail.invalidate(),
      ]);
    },
    onError: (error: { message?: string | null }) => {
      showErrorNotification({
        title: 'Could not post review',
        error: new Error(error.message ?? 'Please try again later.'),
      });
    },
  });

  const isEditing = !!myReview;
  const overLimit = details.length > LISTING_REVIEW_DETAILS_MAX;

  const handleSubmit = () => {
    if (recommended == null) {
      showErrorNotification({
        title: 'Pick a rating',
        error: new Error('Choose 👍 or 👎 before posting.'),
      });
      return;
    }
    upsert.mutate({
      appListingId,
      recommended,
      details: details.trim() ? details.trim() : undefined,
    });
  };

  return (
    <>
      <Modal
        opened={opened}
        onClose={() => (upsert.isPending ? undefined : close())}
        title={isEditing ? 'Edit your review' : 'Review this app'}
        size="md"
        centered
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Would you recommend this app to others?
          </Text>

          <Group gap="sm">
            <Button
              variant={recommended === true ? 'filled' : 'default'}
              color="green"
              leftSection={<IconThumbUp size={16} />}
              onClick={() => setRecommended(true)}
            >
              Recommend
            </Button>
            <Button
              variant={recommended === false ? 'filled' : 'default'}
              color="red"
              leftSection={<IconThumbDown size={16} />}
              onClick={() => setRecommended(false)}
            >
              Don&apos;t recommend
            </Button>
          </Group>

          <Textarea
            label="Details (optional)"
            placeholder="What did you think of this app?"
            value={details}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
              setDetails(e.currentTarget.value)
            }
            maxLength={LISTING_REVIEW_DETAILS_MAX}
            autosize
            minRows={3}
            maxRows={8}
            error={
              overLimit
                ? `Max ${LISTING_REVIEW_DETAILS_MAX.toLocaleString()} characters`
                : undefined
            }
          />

          <Button
            onClick={handleSubmit}
            loading={upsert.isPending}
            disabled={recommended == null || overLimit}
            leftSection={<IconThumbUp size={16} />}
          >
            {isEditing ? 'Update review' : 'Post review'}
          </Button>
        </Stack>
      </Modal>
    </>
  );
}

/**
 * The standalone review affordance: eligibility gate + a compact Button + the modal.
 *
 * UNCHANGED public API and unchanged behaviour — it is now composed from the two
 * exports above rather than inlining them. `ReviewListingButton.browser.test.tsx` is
 * the regression guard for that claim (gating for owner / signed-out / other, plus
 * the write wiring, all asserted through this component).
 */
export function ReviewListingButton({
  appListingId,
  ownerUserId,
  listingKind,
}: {
  appListingId: string;
  /** The listing owner's user id — the CTA is hidden for them (no self-review). */
  ownerUserId: number | null;
  /** The listing's kind — forwarded to the store-scope gate. See {@link useCanReviewListing}. */
  listingKind?: StoreListingKind;
}) {
  const canReview = useCanReviewListing({ ownerUserId, listingKind });
  const [opened, { open, close }] = useDisclosure(false);
  // Same query, same key as the modal's — react-query dedupes, so the label and the
  // modal title cannot disagree about whether this is an edit.
  const { data: myReview } = trpc.appListings.getMyReview.useQuery(
    { appListingId },
    { enabled: canReview && opened }
  );

  // Signed-out → no CTA (the proc is protected). Owner → no self-review CTA.
  if (!canReview) return null;

  return (
    <>
      <Button variant="light" size="xs" leftSection={<IconThumbUp size={14} />} onClick={open}>
        {myReview ? 'Edit review' : 'Leave a review'}
      </Button>
      <ReviewListingModal appListingId={appListingId} opened={opened} onClose={close} />
    </>
  );
}
