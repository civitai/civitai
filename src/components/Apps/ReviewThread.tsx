import { Alert, Badge, Button, Group, Loader, Paper, Stack, Text, Textarea } from '@mantine/core';
import { useState } from 'react';

import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { APP_REVIEW_TEAM_NAME } from '~/server/notifications/app-review-attribution';
import {
  canSubmitReviewReply,
  REVIEW_MESSAGE_BODY_MAX,
  type ReviewMessageAuthorRole,
} from '~/shared/utils/app-review-thread';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** One message as `appListings.listReviewMessages` returns it (no user ids). */
export type ReviewThreadMessageView = {
  id: number;
  body: string;
  createdAt: Date | string;
  authorRole: ReviewMessageAuthorRole;
  author: { username: string | null; image: string | null; deletedAt: Date | string | null } | null;
};

/** The label beside each author: which side of the review they wrote from. */
export const REVIEW_THREAD_ROLE_LABELS: Record<ReviewMessageAuthorRole, string> = {
  developer: 'Developer',
  moderator: APP_REVIEW_TEAM_NAME,
};

function ReviewThreadMessageRow({ message }: { message: ReviewThreadMessageView }) {
  return (
    <Paper withBorder p="sm" radius="md" data-testid={`review-thread-message-${message.id}`}>
      <Stack gap={6}>
        <Group gap="xs" wrap="wrap">
          {message.author ? (
            <UserAvatar
              user={{
                username: message.author.username,
                image: message.author.image,
                deletedAt: message.author.deletedAt ? new Date(message.author.deletedAt) : null,
              }}
              size="xs"
              withUsername
              linkToProfile
            />
          ) : (
            <Text size="sm" c="dimmed">
              [deleted]
            </Text>
          )}
          <Badge
            size="xs"
            variant="light"
            color={message.authorRole === 'moderator' ? 'blue' : 'gray'}
            data-testid={`review-thread-role-${message.id}`}
          >
            {REVIEW_THREAD_ROLE_LABELS[message.authorRole]}
          </Badge>
          <Text size="xs" c="dimmed">
            {formatDate(message.createdAt, 'MMM D, YYYY h:mm A')}
          </Text>
        </Group>
        {/* Plain text, never HTML; line breaks kept. */}
        <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {message.body}
        </Text>
      </Stack>
    </Paper>
  );
}

/** The pure view: messages oldest first, then the reply box. */
export function ReviewThreadView({
  messages,
  loading = false,
  errorMessage = null,
  draft,
  onDraftChange,
  onSubmit,
  pending = false,
  emptyText = 'No messages yet.',
}: {
  messages: ReviewThreadMessageView[];
  loading?: boolean;
  errorMessage?: string | null;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  pending?: boolean;
  emptyText?: string;
}) {
  return (
    <Stack gap="sm" data-testid="review-thread">
      {errorMessage ? (
        <Alert color="red" variant="light" data-testid="review-thread-error">
          {errorMessage}
        </Alert>
      ) : loading ? (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            Loading conversation…
          </Text>
        </Group>
      ) : messages.length === 0 ? (
        <Text size="sm" c="dimmed" data-testid="review-thread-empty">
          {emptyText}
        </Text>
      ) : (
        messages.map((m) => <ReviewThreadMessageRow key={m.id} message={m} />)
      )}
      <Textarea
        label="Reply"
        placeholder="Write a reply"
        autosize
        minRows={3}
        maxRows={12}
        maxLength={REVIEW_MESSAGE_BODY_MAX}
        value={draft}
        onChange={(e) => onDraftChange(e.currentTarget.value)}
        disabled={pending}
        data-testid="review-thread-input"
      />
      <Group justify="space-between">
        <Text size="xs" c="dimmed" data-testid="review-thread-counter">
          {draft.length}/{REVIEW_MESSAGE_BODY_MAX}
        </Text>
        <Button
          size="xs"
          onClick={onSubmit}
          loading={pending}
          disabled={!canSubmitReviewReply(draft, pending)}
          data-testid="review-thread-submit"
        >
          Send reply
        </Button>
      </Group>
    </Stack>
  );
}

/**
 * The thread on one submission, for both sides: its developer (`/apps/submissions/<id>`) and
 * moderators (the review page's Conversation tab, the queue's Replies tab). Render it only when
 * `features.appReviewReplies` is on; the query is gated on the flag as well.
 */
export function ReviewThread({ subjectId }: { subjectId: string }) {
  const features = useFeatureFlags();
  const enabled = !!features?.appReviewReplies;
  const [draft, setDraft] = useState('');
  const utils = trpc.useUtils();
  const query = trpc.appListings.listReviewMessages.useQuery(
    { subjectId },
    { enabled, retry: false }
  );
  const post = trpc.appListings.postReviewMessage.useMutation({
    onSuccess: () => {
      setDraft('');
      void utils.appListings.listReviewMessages.invalidate({ subjectId });
      void utils.appListings.countRepliesAwaitingQueue.invalidate();
      void utils.appListings.listRepliesAwaitingModerator.invalidate();
    },
    onError: (e) => showErrorNotification({ title: 'Reply not sent', error: new Error(e.message) }),
  });

  if (!enabled) return null;
  return (
    <ReviewThreadView
      messages={(query.data ?? []) as ReviewThreadMessageView[]}
      loading={query.isLoading}
      errorMessage={query.error?.message ?? null}
      draft={draft}
      onDraftChange={setDraft}
      onSubmit={() => {
        if (canSubmitReviewReply(draft, post.isPending)) {
          post.mutate({ subjectId, body: draft.trim() });
        }
      }}
      pending={post.isPending}
    />
  );
}
