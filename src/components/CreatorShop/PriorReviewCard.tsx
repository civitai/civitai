import { Alert, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconHistory } from '@tabler/icons-react';
import {
  HISTORY_FIELD_LABELS,
  PRIOR_REVIEW_LABELS,
  type PriorReview,
} from '~/components/CreatorShop/review-history';
import { formatDate } from '~/utils/date-helpers';

/**
 * The unanswered verdict this item already carries, above the fold in the review
 * panel. The History card below has the same facts, but it sits under the price,
 * checks and similarity panels — a reviewer can approve without ever reaching it.
 */
export function PriorReviewCard({ prior }: { prior: PriorReview }) {
  const swapped = prior.artworkSwaps > 0;
  return (
    <Alert
      variant="light"
      color={swapped ? 'orange' : 'yellow'}
      icon={swapped ? <IconAlertTriangle size={18} /> : <IconHistory size={18} />}
      title={`Previously: ${PRIOR_REVIEW_LABELS[prior.action].toLowerCase()}`}
    >
      <Stack gap={4}>
        {!!prior.note && <Text size="sm">“{prior.note}”</Text>}
        <Text size="xs" c="dimmed">
          user #{prior.reviewerId} · {formatDate(prior.at, 'MMM D, YYYY h:mm A')}
        </Text>
        {swapped && (
          <Text size="sm" fw={600}>
            Artwork replaced {prior.artworkSwaps} time{prior.artworkSwaps === 1 ? '' : 's'} since —
            check the History card that this is a revision of what was reviewed, not a different
            piece on the same paid slot.
          </Text>
        )}
        {!!prior.editedFields.length && (
          <Text size="xs" c="dimmed">
            Also changed since:{' '}
            {prior.editedFields.map((f) => HISTORY_FIELD_LABELS[f] ?? f).join(', ')}
          </Text>
        )}
      </Stack>
    </Alert>
  );
}
