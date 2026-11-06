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
  isPostable,
  isScheduleBusy,
  toBatchImage,
} from './batch-composer.utils';

export type BatchSubmissionPayload = {
  modelVersionId: number | null;
  tags: string[];
  tools: number[];
  techniques: number[];
  /** Extra model versions every post lists; the promoted version is `modelVersionId`. */
  resourceIds: number[];
};

type Created = { postId: number; publishedAt: string; alreadyCreated?: true };
type Recognised = { key: string; title: string | null; publishedAt: string };
type Phase = 'running' | 'failed' | 'busy' | 'done';

export function BatchProgressModal({
  posts,
  payload,
  viewScheduledHref,
  calendarHref,
  onCreated,
  onHardFailure,
  onDone,
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
  onDone: () => void;
  onScheduleAnother: () => void;
  onKeepEditing: () => void;
}) {
  const scheduleBatch = trpc.post.scheduleBatch.useMutation();
  const [phase, setPhase] = useState<Phase>('running');
  const [done, setDone] = useState(0);
  const [failed, setFailed] = useState<PlannedPost[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const createdRef = useRef<Created[]>([]);
  const [recognised, setRecognised] = useState<Recognised[]>([]);
  // One key per post for the life of this screen, so a retry of a call that timed out on our side
  // but finished on the server gets that post back instead of a second one.
  const clientKeysRef = useRef(new Map<string, string>());
  const clientKeyFor = (post: PlannedPost) => {
    let key = clientKeysRef.current.get(post.key);
    if (!key) {
      key = crypto.randomUUID();
      clientKeysRef.current.set(post.key, key);
    }
    return key;
  };
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
          modelVersionId: payload.modelVersionId,
          tags: payload.tags,
          tools: payload.tools,
          techniques: payload.techniques,
          resourceIds: payload.resourceIds,
          posts: chunk.map((post) => ({
            clientKey: clientKeyFor(post),
            title: post.title,
            publishedAt: post.publishedAt,
            images: post.media.filter(isPostable).map(toBatchImage),
          })),
        });
        createdRef.current.push(...result.created);
        const earlier = result.created.flatMap((entry, index) =>
          entry.alreadyCreated
            ? [{ key: chunk[index].key, title: chunk[index].title, publishedAt: entry.publishedAt }]
            : []
        );
        if (earlier.length) setRecognised((current) => [...current, ...earlier]);
        onCreated(chunk.slice(0, result.created.length).map((post) => post.key));
        setDone(createdRef.current.length);
        if (result.failedAt !== undefined && result.failedAt !== null) {
          fail([...chunk.slice(result.failedAt), ...rest], result.message ?? 'Some posts failed.');
          return;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // An earlier attempt the client gave up on still holds the creator's schedule lock. Not a
        // failure: once it finishes, retrying returns whatever it made instead of making it twice.
        if (isScheduleBusy(reason)) {
          setFailed([...chunk, ...rest]);
          setPhase('busy');
          return;
        }
        fail([...chunk, ...rest], reason);
        return;
      }
    }
    setPhase('done');
    onDone();
  };

  const fail = (failedPosts: PlannedPost[], reason: string) => {
    if (!createdRef.current.length) {
      onHardFailure(describeServerError(reason));
      return;
    }
    setFailed(failedPosts);
    setMessage(describeServerError(reason, createdRef.current.length));
    setPhase('failed');
  };

  // StrictMode mounts twice in development and a remount would resubmit; the ref survives both.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void run(posts);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const created = createdRef.current;
  // By time, not order: a post an earlier attempt made keeps its own date wherever it sits.
  const times = created.map((entry) => new Date(entry.publishedAt).getTime());
  const first = times.length ? new Date(Math.min(...times)) : null;
  const last = times.length ? new Date(Math.max(...times)) : null;
  // Locked only while posts are being created; closing a finished screen takes its plain way out.
  const dismissible = phase !== 'running';
  // A date edited before a resubmit did not take for these; say so, with the time that did.
  const recognisedNote = recognised.length > 0 && (
    <div className="flex flex-col gap-1" data-testid="batch-recognised">
      <Text size="xs" c="dimmed">
        {recognised.length === 1
          ? 'This post was already scheduled by an earlier attempt and keeps the time it set:'
          : `These ${recognised.length} posts were already scheduled by an earlier attempt and keep the times it set:`}
      </Text>
      <div className="max-h-[160px] overflow-auto">
        {recognised.map((post) => (
          <div key={post.key} className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate">{post.title ?? 'Untitled'}</span>
            <span className="whitespace-nowrap text-gray-6 dark:text-gray-4">
              {formatDate(post.publishedAt, 'MMM D, h:mm A')}
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <Modal
      opened
      onClose={() => {
        if (phase === 'done') onScheduleAnother();
        else if (phase === 'failed' || phase === 'busy') onKeepEditing();
      }}
      withCloseButton={dismissible}
      closeOnClickOutside={dismissible}
      closeOnEscape={dismissible}
      centered
      title={
        phase === 'running'
          ? 'Creating posts…'
          : phase === 'done'
          ? `${created.length} ${created.length === 1 ? 'post' : 'posts'} scheduled`
          : phase === 'busy'
          ? 'Still finishing an earlier attempt'
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
          {recognisedNote}
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
      {phase === 'busy' && (
        <div className="flex flex-col gap-3" data-testid="batch-busy">
          <Text size="sm">
            An earlier attempt to schedule these posts is still finishing. Give it a moment, then
            try again: any post it already made comes back as it is, not twice.
          </Text>
          {recognisedNote}
          <Button onClick={() => void run(failed)}>Try again</Button>
          <Button variant="default" onClick={onKeepEditing}>
            Keep editing
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
          {recognisedNote}
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
