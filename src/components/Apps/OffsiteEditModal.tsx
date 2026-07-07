import { Alert, Button, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconInfoCircle, IconPencil } from '@tabler/icons-react';
import { useMemo, useState } from 'react';

import type { OffsiteSubmission } from '~/components/Apps/OffsiteSubmissionsList';
import { validateExternalUrl } from '~/server/schema/blocks/external-app.schema';
import {
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_CATEGORY_LABELS,
  type MarketplaceCategory,
} from '~/server/services/blocks/marketplace-categories.constants';
import {
  OFFSITE_CONTENT_RATINGS,
  type OffsiteContentRating,
  type UpdateListingPatch,
} from '~/server/schema/blocks/offsite-listing.schema';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * App Store Listings (W13) — EDIT-without-withdraw modal (author).
 *
 * A focused, minimal editor for the scalar display fields of an off-site listing
 * the author still owns and can edit in place / stage for re-review:
 *   - a PENDING request → the backing listing is a live DRAFT under review → edits
 *     apply IN PLACE (no re-review),
 *   - an APPROVED request → the listing is LIVE. A trivial edit (category /
 *     contentRating) applies in place; a MATERIAL edit (name / externalUrl) is
 *     staged as a shadow-draft revision and, because the shadow inherits the live
 *     listing's already-complete assets, auto-submitted for re-review here — the
 *     current version stays live until a moderator re-approves.
 *
 * SCOPE (deferred to a follow-up): tagline/description editing + a full
 * asset-re-edit flow (reusing `ExternalSubmitForm` + the OG metadata auto-pull)
 * for a material revision that also changes imagery. This modal changes only the
 * fields whose current values the my-submissions payload already carries, so it
 * never accidentally clears an un-prefilled field.
 */

const CATEGORY_OPTIONS = MARKETPLACE_CATEGORIES.map((c) => ({
  value: c,
  label: MARKETPLACE_CATEGORY_LABELS[c],
}));
const RATING_OPTIONS = OFFSITE_CONTENT_RATINGS.map((r) => ({ value: r, label: r.toUpperCase() }));

export function OffsiteEditModal({ submission }: { submission: OffsiteSubmission }) {
  const [opened, { open, close }] = useDisclosure(false);
  const utils = trpc.useUtils();

  const listingId = submission.appListingId;
  const isApproved = submission.status === 'approved';
  const orig = useMemo(
    () => ({
      name: submission.appListing?.name ?? '',
      externalUrl: submission.appListing?.externalUrl ?? '',
      category: submission.appListing?.category ?? null,
      contentRating: submission.appListing?.contentRating ?? 'g',
    }),
    [submission]
  );

  const [name, setName] = useState(orig.name);
  const [externalUrl, setExternalUrl] = useState(orig.externalUrl);
  const [category, setCategory] = useState<string | null>(orig.category);
  const [contentRating, setContentRating] = useState<string>(orig.contentRating);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const reset = () => {
    setName(orig.name);
    setExternalUrl(orig.externalUrl);
    setCategory(orig.category);
    setContentRating(orig.contentRating);
    setInlineError(null);
  };

  const done = (title: string, message: string) => {
    showSuccessNotification({ title, message });
    void utils.appListings.listMySubmissions.invalidate();
    close();
  };

  const submitRevision = trpc.appListings.submitListingRevision.useMutation({
    onSuccess: () =>
      done('Sent for review', 'Your current version stays live until a moderator re-approves.'),
    onError: (error: { message?: string | null }) => {
      setInlineError(error.message ?? 'Failed to submit the revision for review.');
      showErrorNotification({ error: new Error(error.message ?? 'Revision submit failed') });
    },
  });

  const update = trpc.appListings.updateListing.useMutation({
    onSuccess: (data: { requiresReview: boolean; shadowId: string | null }) => {
      if (data.requiresReview && data.shadowId) {
        // A material edit was staged on a shadow (assets inherited from the live
        // listing) — submit it for re-review so it actually reaches the queue.
        submitRevision.mutate({ shadowId: data.shadowId });
        return;
      }
      done('Saved', 'Your changes are live.');
    },
    onError: (error: { message?: string | null }) => {
      setInlineError(error.message ?? 'Failed to save your changes.');
    },
  });

  const busy = update.isPending || submitRevision.isPending;

  const buildPatch = (): UpdateListingPatch => {
    const patch: UpdateListingPatch = {};
    if (name !== orig.name) patch.name = name;
    if (externalUrl !== orig.externalUrl) patch.externalUrl = externalUrl;
    // The Select options are exactly MARKETPLACE_CATEGORIES (or cleared → null),
    // and the RATING options are exactly OFFSITE_CONTENT_RATINGS, so these casts
    // reflect the constrained option sets (the server re-validates regardless).
    if (category !== orig.category) patch.category = category as MarketplaceCategory | null;
    if (contentRating !== orig.contentRating)
      patch.contentRating = contentRating as OffsiteContentRating;
    return patch;
  };

  const onSubmit = () => {
    setInlineError(null);
    if (!listingId) {
      setInlineError('This submission has no editable listing.');
      return;
    }
    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      close();
      return;
    }
    if (patch.externalUrl !== undefined && !validateExternalUrl(patch.externalUrl).ok) {
      setInlineError('The link must be a valid https:// URL.');
      return;
    }
    if (name.trim().length === 0) {
      setInlineError('Name is required.');
      return;
    }
    update.mutate({ listingId, patch });
  };

  return (
    <>
      <Button
        size="xs"
        variant="default"
        leftSection={<IconPencil size={12} />}
        onClick={() => {
          reset();
          open();
        }}
        data-testid={`apps-offsite-edit-${submission.slug}`}
      >
        Edit
      </Button>
      <Modal opened={opened} onClose={close} title={`Edit ${orig.name || submission.slug}`} centered>
        <Stack gap="sm">
          {isApproved && (
            <Alert
              icon={<IconInfoCircle size={16} />}
              color="blue"
              variant="light"
              data-testid="apps-offsite-edit-approved-notice"
            >
              <Text size="sm">
                This app is live. Editing the <b>name</b> or <b>link</b> sends the change to
                moderator review — your current version stays live until it&apos;s re-approved.
                Category and rating changes apply immediately.
              </Text>
            </Alert>
          )}
          <TextInput
            label="Name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            maxLength={120}
            data-testid="apps-offsite-edit-name"
          />
          <TextInput
            label="Link (https://)"
            value={externalUrl}
            onChange={(e) => setExternalUrl(e.currentTarget.value)}
            data-testid="apps-offsite-edit-url"
          />
          <Select
            label="Category"
            data={CATEGORY_OPTIONS}
            value={category}
            onChange={setCategory}
            clearable
            data-testid="apps-offsite-edit-category"
          />
          <Select
            label="Content rating"
            data={RATING_OPTIONS}
            value={contentRating}
            onChange={(v) => setContentRating(v ?? 'g')}
            allowDeselect={false}
            data-testid="apps-offsite-edit-rating"
          />
          {inlineError && (
            <Text size="sm" c="red" data-testid="apps-offsite-edit-error">
              {inlineError}
            </Text>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={onSubmit} loading={busy} data-testid="apps-offsite-edit-save">
              {isApproved ? 'Save / submit for review' : 'Save'}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
