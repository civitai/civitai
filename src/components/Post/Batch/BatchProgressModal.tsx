import { Button, Modal, Progress, Text } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useCatchNavigation } from '~/store/catch-navigation.store';
import { formatDate } from '~/utils/date-helpers';
import dayjs from 'dayjs';
import { trpc } from '~/utils/trpc';
import type { PlannedPost } from './batch-composer.utils';
import {
  chunkPosts,
  chunkSizeFor,
  describeServerError,
  toBatchImage,
} from './batch-composer.utils';

export type BatchSubmissionPayload = {
  modelVersionId: number | null;
  tags: string[];
  tools: number[];
  techniques: number[];
  extraResourceIds: number[];
};

type Created = { postId: number; publishedAt: string };
type Phase = 'running' | 'failed' | 'done';

export function BatchProgressModal({
  posts,
  payload,
  viewScheduledHref,
  calendarHref,
  onCreated,
  onHardFailure,
  onScheduleAnother,
  onKeepEditing,
}: {
  posts: PlannedPost[];
  payload: BatchSubmissionPayload;
  viewScheduledHref: string;
  /** The planner, when a host for it exists; the first scheduled day is appended as the anchor. */
  calendarHref: string | null;
  onCreated: (keys: string[]) => void;
  onHardFailure: (message: string) => void;
  onScheduleAnother: () => void;
  onKeepEditing: () => void;
}) {
  const scheduleBatch = trpc.post.scheduleBatch.useMutation();
  const [phase, setPhase] = useState<Phase>('running');
  const [done, setDone] = useState(0);
  const [failed, setFailed] = useState<PlannedPost[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const createdRef = useRef<Created[]>([]);
  const startedRef = useRef(false);
  const total = posts.length;

  useCatchNavigation({
    name: 'batch-submission',
    message: 'Posts are still being created. Leave anyway?',
    predicate: phase === 'running',
  });

  const run = async (toSubmit: PlannedPost[]) => {
    setPhase('running');
    setFailed([]);
    setMessage(null);
    const chunks = chunkPosts(
      toSubmit.map((post) => ({ post, images: post.media })),
      { maxPosts: chunkSizeFor(toSubmit.length) }
    );
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i].map((x) => x.post);
      const rest = chunks.slice(i + 1).flatMap((c) => c.map((x) => x.post));
      try {
        const result = await scheduleBatch.mutateAsync({
          idempotencyKey: crypto.randomUUID(),
          modelVersionId: payload.modelVersionId,
          tags: payload.tags,
          tools: payload.tools,
          techniques: payload.techniques,
          posts: chunk.map((post) => ({
            title: post.title,
            publishedAt: post.publishedAt,
            images: post.media.map((media) => toBatchImage(media, payload.extraResourceIds)),
          })),
        });
        createdRef.current.push(...result.created);
        onCreated(chunk.slice(0, result.created.length).map((post) => post.key));
        setDone(createdRef.current.length);
        if (result.failedAt !== undefined && result.failedAt !== null) {
          fail([...chunk.slice(result.failedAt), ...rest], result.message ?? 'Some posts failed.');
          return;
        }
      } catch (error) {
        fail([...chunk, ...rest], error instanceof Error ? error.message : String(error));
        return;
      }
    }
    setPhase('done');
  };

  const fail = (failedPosts: PlannedPost[], reason: string) => {
    if (!createdRef.current.length) {
      onHardFailure(describeServerError(reason));
      return;
    }
    setFailed(failedPosts);
    setMessage(describeServerError(reason));
    setPhase('failed');
  };

  // StrictMode mounts twice in development and a remount would resubmit; the ref survives both.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void run(posts);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const created = createdRef.current;
  const first = created.length ? new Date(created[0].publishedAt) : null;
  const last = created.length ? new Date(created[created.length - 1].publishedAt) : null;

  return (
    <Modal
      opened
      onClose={() => undefined}
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
      centered
      title={
        phase === 'running'
          ? 'Creating posts…'
          : phase === 'done'
          ? `${created.length} ${created.length === 1 ? 'post' : 'posts'} scheduled`
          : `${created.length} scheduled, ${failed.length} failed`
      }
      data-testid="batch-progress-modal"
    >
      {phase === 'running' && (
        <div className="flex flex-col gap-2">
          <Text size="sm" data-testid="batch-progress-count">
            {done} / {total}
          </Text>
          <Progress value={total ? (done / total) * 100 : 0} size="lg" animated />
          <Text size="xs" c="dimmed">
            Keep this tab open until every post is created.
          </Text>
        </div>
      )}
      {phase === 'done' && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-green-7 dark:text-green-4">
            <IconCheck size={20} />
            <Text size="sm" data-testid="batch-success-summary">
              {created.length} {created.length === 1 ? 'post' : 'posts'} scheduled
              {first && last
                ? ` · First goes live ${formatDate(first, 'ddd MMM D, h:mm A')} · last ${formatDate(
                    last,
                    'ddd MMM D'
                  )}`
                : ''}
            </Text>
          </div>
          {calendarHref && first && (
            <Button
              component={Link}
              href={`${calendarHref}?view=month&anchor=${dayjs(first).format('YYYY-MM-DD')}`}
            >
              Open calendar
            </Button>
          )}
          <Button
            component={Link}
            href={viewScheduledHref}
            variant={calendarHref ? 'default' : 'filled'}
          >
            View scheduled posts
          </Button>
          <Button variant="default" onClick={onScheduleAnother}>
            Schedule another batch
          </Button>
        </div>
      )}
      {phase === 'failed' && (
        <div className="flex flex-col gap-3">
          {message && (
            <Text size="sm" c="red">
              {message}
            </Text>
          )}
          <div className="max-h-[240px] overflow-auto rounded border border-gray-2 dark:border-dark-5">
            {failed.map((post) => (
              <div
                key={post.key}
                className="flex items-center justify-between gap-2 border-b border-gray-2 px-2 py-1 text-sm last:border-b-0 dark:border-dark-5"
              >
                <span className="truncate">{post.title ?? 'Untitled'}</span>
                <span className="whitespace-nowrap text-gray-6 dark:text-gray-4">
                  {formatDate(post.publishedAt, 'MMM D, h:mm A')}
                </span>
              </div>
            ))}
          </div>
          <Text size="xs" c="dimmed">
            Their images are kept; retry creates only the posts that failed.
          </Text>
          <Button onClick={() => void run(failed)}>Retry {failed.length}</Button>
          <Button variant="default" onClick={onKeepEditing}>
            Keep editing
          </Button>
        </div>
      )}
    </Modal>
  );
}
