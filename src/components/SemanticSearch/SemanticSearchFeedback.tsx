import { ActionIcon, Button, Group, Text, Textarea } from '@mantine/core';
import { IconThumbDown, IconThumbUp } from '@tabler/icons-react';
import { useState } from 'react';

export type FeedbackRating = 'up' | 'down';

export function SemanticSearchFeedback({
  onSubmit,
  submitting,
  submitted,
}: {
  onSubmit: (feedback: { rating: FeedbackRating; comment?: string }) => void;
  submitting?: boolean;
  submitted?: boolean;
}) {
  const [rating, setRating] = useState<FeedbackRating>();
  const [comment, setComment] = useState('');

  if (submitted)
    return (
      <Text size="sm" c="dimmed">
        Thanks, your feedback was saved.
      </Text>
    );

  return (
    <div className="flex flex-col gap-2 rounded-md border border-gray-3 p-3 dark:border-dark-4">
      <Group gap="xs">
        <Text size="sm">Were these results useful?</Text>
        <ActionIcon
          aria-label="Useful"
          variant={rating === 'up' ? 'filled' : 'default'}
          color="green"
          onClick={() => setRating('up')}
        >
          <IconThumbUp size={16} />
        </ActionIcon>
        <ActionIcon
          aria-label="Not useful"
          variant={rating === 'down' ? 'filled' : 'default'}
          color="red"
          onClick={() => setRating('down')}
        >
          <IconThumbDown size={16} />
        </ActionIcon>
      </Group>
      {rating && (
        <>
          <Textarea
            placeholder="What was good or wrong about these results? (optional)"
            value={comment}
            onChange={(e) => setComment(e.currentTarget.value)}
            maxLength={2000}
            autosize
            minRows={2}
          />
          <Group>
            <Button
              size="xs"
              loading={submitting}
              onClick={() => onSubmit({ rating, comment: comment.trim() || undefined })}
            >
              Send feedback
            </Button>
          </Group>
        </>
      )}
    </div>
  );
}
