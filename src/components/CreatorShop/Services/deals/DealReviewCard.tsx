import { Badge, Button, Group, Paper, Stack, Text, Textarea } from '@mantine/core';
import { useState } from 'react';
import { Countdown } from '~/components/Countdown/Countdown';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import {
  reviewEditable,
  reviewPaymentLine,
  reviewStatusLine,
} from '~/components/CreatorShop/Services/deals/deal-review-ui';
import type { ServiceDealView } from '~/components/CreatorShop/Services/deals/deal.util';
import { useServiceDealMutations } from '~/components/CreatorShop/Services/deals/deal.util';
import { trpc } from '~/utils/trpc';
import { formatDate } from '~/utils/date-helpers';

const DATE = 'MMM D, YYYY h:mm A';
const MAX = 2000;
const VERDICT_LABEL = { Happy: 'Happy', NotQuite: 'Not quite' } as const;

type DealReview = NonNullable<ServiceDealView['review']>;

/**
 * Replaces the dispute window on a deal enrolled in reviews, for a viewer with the review flag. The
 * buyer marks the work happy (which pays the seller now) or not quite, with an optional comment;
 * the seller waits, then may reply once; a moderator can hide the review.
 */
export function DealReviewCard({
  deal,
  state,
  until,
}: {
  deal: ServiceDealView;
  state: DealReview;
  until: Date | null;
}) {
  const role = deal.viewerRole;
  const seller = deal.seller.username ?? 'the seller';
  const review = state.review;
  return (
    <Paper withBorder radius="md" p="md">
      <Stack gap="sm">
        {!review ? (
          role === 'buyer' ? (
            <AskForReview deal={deal} seller={seller} until={until} />
          ) : (
            <Stack gap={4}>
              <Text fw={600}>Waiting for the buyer&apos;s review</Text>
              {until && (
                <Text size="sm" c="dimmed">
                  {role === 'seller'
                    ? `The buyer can review this until ${formatDate(
                        until,
                        DATE
                      )}. You're paid then, or as soon as they mark it happy.`
                    : `The buyer can review this until ${formatDate(
                        until,
                        DATE
                      )}. After that, the Buzz is paid to the seller.`}
                </Text>
              )}
            </Stack>
          )
        ) : (
          <ReviewShown deal={deal} state={state} seller={seller} />
        )}
      </Stack>
    </Paper>
  );
}

function AskForReview({
  deal,
  seller,
  until,
}: {
  deal: ServiceDealView;
  seller: string;
  until: Date | null;
}) {
  const mutations = useServiceDealMutations(deal.id);
  const [comment, setComment] = useState('');
  const submit = (verdict: 'Happy' | 'NotQuite') =>
    mutations.review.mutate({ id: deal.id, verdict, comment: comment.trim() || undefined });
  const pending = mutations.review.isPending;
  return (
    <Stack gap="sm">
      <Text fw={600}>How did it turn out?</Text>
      <Text size="sm" c="dimmed">
        Happy pays {seller} now, and you can no longer report a problem. Not quite leaves the
        payment to the end of the report window
        {until ? (
          <>
            , which closes in <Countdown endTime={until} />
          </>
        ) : null}
        . If the files are missing or broken, report a problem instead.
      </Text>
      <Textarea
        label="Comment (optional)"
        value={comment}
        onChange={(e) => setComment(e.currentTarget.value)}
        maxLength={MAX}
        autosize
        minRows={2}
      />
      <Text size="xs" c="dimmed">
        Your review is public, with your username.
      </Text>
      <Group gap="sm">
        <Button onClick={() => submit('Happy')} loading={pending}>
          Happy, pay {seller}
        </Button>
        <Button variant="default" onClick={() => submit('NotQuite')} loading={pending}>
          Not quite
        </Button>
      </Group>
    </Stack>
  );
}

function ReviewShown({
  deal,
  state,
  seller,
}: {
  deal: ServiceDealView;
  state: DealReview;
  seller: string;
}) {
  const review = state.review!;
  const role = deal.viewerRole;
  const mutations = useServiceDealMutations(deal.id);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(review.comment ?? '');
  const [reply, setReply] = useState('');
  const payment = reviewPaymentLine(state, seller, role);
  const editable = role === 'buyer' && reviewEditable(review);
  const finals = trpc.creatorServiceDeal.reviewAttachableFinals.useQuery(
    { id: deal.id },
    { enabled: role === 'buyer' && !review.hidden }
  );

  return (
    <Stack gap="sm">
      <Group gap="xs">
        <Text fw={600}>{role === 'buyer' ? 'Your review' : "The buyer's review"}</Text>
        <Badge variant="light" color={review.verdict === 'Happy' ? 'green' : 'gray'}>
          {VERDICT_LABEL[review.verdict]}
        </Badge>
      </Group>
      {payment && <Text size="sm">{payment}</Text>}
      {editing ? (
        <Stack gap="xs">
          <Textarea
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            maxLength={MAX}
            autosize
            minRows={2}
          />
          <Group gap="sm">
            <Button
              size="xs"
              loading={mutations.editReview.isPending}
              onClick={() =>
                mutations.editReview.mutate(
                  { id: deal.id, comment: text.trim() || undefined },
                  { onSuccess: () => setEditing(false) }
                )
              }
            >
              Save
            </Button>
            <Button size="xs" variant="default" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </Group>
        </Stack>
      ) : (
        review.comment && (
          <Text size="sm" className="whitespace-pre-line break-words">
            {review.comment}
          </Text>
        )
      )}
      {review.images.length > 0 && (
        <Group gap="xs">
          {review.images.map((image) => (
            <EdgeMedia
              key={image.id}
              src={image.url}
              type="image"
              width={160}
              className="rounded"
            />
          ))}
        </Group>
      )}
      {role === 'buyer' && (
        <Text size="xs" c="dimmed">
          {reviewStatusLine(review, state.settled)}
        </Text>
      )}
      {editable && !editing && (
        <Group gap="sm">
          <Button size="xs" variant="default" onClick={() => setEditing(true)}>
            Edit comment
          </Button>
          {review.editableUntil && (
            <Text size="xs" c="dimmed">
              until {formatDate(review.editableUntil, DATE)}
            </Text>
          )}
        </Group>
      )}
      {role === 'buyer' && !!finals.data?.length && (
        <Stack gap={4}>
          <Text size="sm">Show the work you received with your review:</Text>
          <Group gap="xs">
            {finals.data.map((file) => (
              <Button
                key={file.id}
                size="xs"
                variant="light"
                loading={mutations.attachReviewImage.isPending}
                onClick={() => mutations.attachReviewImage.mutate({ id: deal.id, fileId: file.id })}
              >
                Add {file.fileName ?? `file #${file.id}`}
              </Button>
            ))}
          </Group>
        </Stack>
      )}
      {review.sellerReply ? (
        <Paper bg="var(--mantine-color-default-hover)" p="sm" radius="sm">
          <Text size="xs" c="dimmed">
            {role === 'seller' ? 'Your reply' : `${seller} replied`}
          </Text>
          <Text size="sm" className="whitespace-pre-line break-words">
            {review.sellerReply}
          </Text>
        </Paper>
      ) : (
        role === 'seller' &&
        !review.sellerReplyScanStatus && (
          <Stack gap="xs">
            <Textarea
              label="Reply (one, public)"
              value={reply}
              onChange={(e) => setReply(e.currentTarget.value)}
              maxLength={MAX}
              autosize
              minRows={2}
            />
            <Group>
              <Button
                size="xs"
                disabled={!reply.trim()}
                loading={mutations.replyToReview.isPending}
                onClick={() => mutations.replyToReview.mutate({ id: deal.id, reply })}
              >
                Reply
              </Button>
            </Group>
          </Stack>
        )
      )}
      {role === 'moderator' && (
        <Group>
          <Button
            size="xs"
            color={review.hidden ? 'gray' : 'red'}
            variant="light"
            loading={mutations.hideReview.isPending}
            onClick={() =>
              mutations.hideReview.mutate({ reviewId: review.id, hidden: !review.hidden })
            }
          >
            {review.hidden ? 'Restore review' : 'Hide review'}
          </Button>
        </Group>
      )}
    </Stack>
  );
}
