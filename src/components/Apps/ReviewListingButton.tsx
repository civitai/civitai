import { Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconThumbDown, IconThumbUp } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import { LISTING_REVIEW_DETAILS_MAX } from '~/server/schema/blocks/app-listing-review.schema';
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
 */
export function ReviewListingButton({
  appListingId,
  ownerUserId,
}: {
  appListingId: string;
  /** The listing owner's user id — the CTA is hidden for them (no self-review). */
  ownerUserId: number | null;
}) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const [opened, { open, close }] = useDisclosure(false);
  const [recommended, setRecommended] = useState<boolean | null>(null);
  const [details, setDetails] = useState('');

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

  // Signed-out → no CTA (the proc is protected). Owner → no self-review CTA.
  if (!currentUser) return null;
  if (ownerUserId != null && ownerUserId === currentUser.id) return null;

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
      <Button
        variant="light"
        size="xs"
        leftSection={<IconThumbUp size={14} />}
        onClick={open}
      >
        {isEditing ? 'Edit review' : 'Leave a review'}
      </Button>

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
