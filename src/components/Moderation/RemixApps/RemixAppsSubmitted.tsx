import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import type { AdminRow } from '~/components/Moderation/RemixApps/RemixAppsAdmin';
import { moderatorAppUrl } from '~/components/Moderation/ModeratorLookupMenuItem';
import { moderatorUserLookupPath } from '~/shared/constants/moderator-app';
import {
  REMIX_REJECT_REASONS,
  REMIX_SYSTEM_ACTOR,
  type RemixRejectReason,
} from '~/shared/remix-apps/row.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import type { RemixGraphNode } from '~/shared/remix-apps/validate';

export type SubmittedRow = Extract<AdminRow, { user: unknown }>;

const REVIEW_COLOR = { submitted: 'yellow', approved: 'green', rejected: 'red' } as const;

/**
 * User apps waiting on, or past, a mod's review. This checks the listing and what the code asks
 * for; the sandbox, not this review, is what keeps the code itself contained.
 */
export function RemixAppsSubmitted({ rows }: { rows: SubmittedRow[] }) {
  return (
    <Stack>
      <Alert color="blue">
        Review the listing and the code itself. A dry run plays the code down every path in the
        sandbox, on a placeholder image: code that branches on the image or on what a viewer types
        can take paths it does not show.
      </Alert>
      {rows.length ? (
        rows.map((row) => (
          <SubmittedApp
            key={row.slug}
            row={row}
            others={rows.filter((r) => r.user.authorId === row.user.authorId && r !== row)}
          />
        ))
      ) : (
        <Text c="dimmed">No user apps have been submitted.</Text>
      )}
    </Stack>
  );
}

function SubmittedApp({ row, others }: { row: SubmittedRow; others: SubmittedRow[] }) {
  const { user } = row;
  // What the mod is reading: a refetch never swaps the code under them, and approval sends its hash.
  const [seen, setSeen] = useState(user);
  const changed = seen.sha256 !== user.sha256 || seen.review !== user.review;
  const [mature, setMature] = useState(user.mature);
  const [reason, setReason] = useState<RemixRejectReason | null>(null);
  const [note, setNote] = useState('');
  const utils = trpc.useUtils();
  const onError = (error: { message: string }) =>
    showErrorNotification({ title: 'Not saved', error: new Error(error.message) });
  const onSuccess = () => utils.remixApp.admin.list.invalidate();
  const review = trpc.remixApp.admin.review.useMutation({
    // Without this the mod's own decision reads as another mod's, and their next one is refused.
    onSuccess: (result) => {
      setSeen((s) => ({ ...s, review: result.review }));
      return onSuccess();
    },
    onError: (error) => {
      // A reject can be saved even when its sweep fails; refetch so the tab shows it.
      onError(error);
      return onSuccess();
    },
  });
  const setEnabled = trpc.remixApp.admin.setEnabled.useMutation({ onSuccess, onError });
  const clearMark = trpc.remixApp.admin.clearMinorThemed.useMutation({ onSuccess, onError });
  const clearHold = trpc.remixApp.admin.clearRunnerHold.useMutation({ onSuccess, onError });
  const dryRun = trpc.remixApp.admin.validate.useMutation({ onError });
  // A dry run of a source other than the one on screen is not shown.
  const run = dryRun.data?.sha256 === seen.sha256 ? dryRun.data : undefined;
  const marked = !!user.minorThemed;
  // The server bars mature on every app of an author with a mark on any of them.
  const authorMarked = marked || others.some((o) => !!o.user.minorThemed);
  const authorHeld = !!user.runnerHold || others.some((o) => !!o.user.runnerHold);

  return (
    <Stack gap="xs" className="rounded-md border border-solid border-gray-3 p-3 dark:border-dark-4">
      <Group justify="space-between">
        <Group gap="xs">
          <Title order={4}>{seen.name}</Title>
          <Badge color={REVIEW_COLOR[user.review]}>{user.review}</Badge>
          {marked && <Badge color="red">minor-themed</Badge>}
          {authorHeld && <Badge color="orange">author held: runner trips</Badge>}
          <Text size="sm" c="dimmed">
            {row.slug} · icon {seen.icon}
          </Text>
        </Group>
        <Switch
          label="Enabled"
          checked={row.enabled}
          disabled={user.review !== 'approved' || setEnabled.isPending}
          onChange={(e) => setEnabled.mutate({ slug: row.slug, enabled: e.currentTarget.checked })}
        />
      </Group>
      <Text size="sm">
        Author{' '}
        <Anchor href={moderatorAppUrl(moderatorUserLookupPath(user.authorId))} target="_blank">
          {user.authorId}
        </Anchor>
        {others.length > 0 &&
          ` · other apps: ${others.map((o) => `${o.slug} (${o.user.review})`).join(', ')}`}
      </Text>
      {changed && (
        <Alert color="yellow">
          This app changed after you opened it: a new submit or another moderator&apos;s decision.{' '}
          <Button
            size="compact-xs"
            variant="light"
            onClick={() => {
              setSeen(user);
              setMature(user.mature);
            }}
          >
            Show the new version
          </Button>
        </Alert>
      )}
      {seen.description && <Text size="sm">{seen.description}</Text>}
      <Code block className="max-h-96 overflow-auto">
        {seen.source}
      </Code>
      <Text size="xs" c="dimmed">
        sha256 {seen.sha256}
      </Text>
      <Group gap="xs">
        <Button
          size="compact-xs"
          variant="light"
          loading={dryRun.isPending}
          onClick={() => dryRun.mutate({ slug: row.slug })}
        >
          Dry-run every path
        </Button>
        {run && (
          <Text size="xs" c={run.issues.length ? 'red' : 'dimmed'}>
            {run.paths} paths · {run.issues.length} issues
          </Text>
        )}
      </Group>
      {run && (
        <Stack gap={2} className="max-h-96 overflow-auto">
          {run.issues.map((issue, i) => (
            <Text key={i} size="xs" c="red">
              {issue.kind}: {issue.message}
              {issue.answers.length ? ` (after ${issue.answers.join(' → ')})` : ''}
            </Text>
          ))}
          <RemixGraphView node={run.graph} />
        </Stack>
      )}
      <Group justify="space-between" align="flex-end">
        <Group gap="xs" align="flex-end">
          <Checkbox
            label="Allow mature sources (adds the mature engine)"
            checked={mature && !authorMarked}
            disabled={authorMarked}
            onChange={(e) => setMature(e.currentTarget.checked)}
          />
          {marked && (
            <Button
              size="compact-xs"
              variant="light"
              loading={clearMark.isPending}
              onClick={() => clearMark.mutate({ slug: row.slug })}
            >
              Clear minor-themed mark
            </Button>
          )}
          {authorHeld && (
            <Button
              size="compact-xs"
              variant="light"
              loading={clearHold.isPending}
              onClick={() => clearHold.mutate({ slug: row.slug })}
            >
              Clear author hold
            </Button>
          )}
        </Group>
        <Group gap="xs" align="flex-end">
          <Select
            placeholder="Reject reason"
            data={[...REMIX_REJECT_REASONS]}
            value={reason}
            onChange={(value) => setReason(value as RemixRejectReason | null)}
          />
          <TextInput
            placeholder="Note to the author"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <Button
            variant="light"
            color="red"
            disabled={!reason}
            loading={review.isPending}
            onClick={() =>
              reason &&
              review.mutate({
                slug: row.slug,
                sha256: seen.sha256,
                seenReview: seen.review,
                decision: 'rejected',
                reason,
                ...(note.trim() ? { note: note.trim() } : {}),
              })
            }
          >
            Reject
          </Button>
          <Button
            loading={review.isPending}
            onClick={() =>
              review.mutate({
                slug: row.slug,
                sha256: seen.sha256,
                seenReview: seen.review,
                decision: 'approved',
                mature: mature && !authorMarked,
              })
            }
          >
            Approve
          </Button>
        </Group>
      </Group>
      {user.reviewLog.length > 0 && (
        <Stack gap={2}>
          {[...user.reviewLog]
            .reverse()
            .slice(0, 10)
            .map((entry, i) => (
              <Text key={i} size="xs" c="dimmed">
                {entry.at} · {entry.action} by{' '}
                {entry.by === REMIX_SYSTEM_ACTOR ? 'the run-time audit' : entry.by}
                {entry.mature ? ' · mature' : ''}
                {entry.reason ? ` · ${entry.reason}` : ''}
                {entry.note ? ` · "${entry.note}"` : ''}
              </Text>
            ))}
        </Stack>
      )}
    </Stack>
  );
}

/** One path per branch: what each step of the code sends, after which answer. */
function RemixGraphView({ node }: { node: RemixGraphNode }) {
  if (node.type === 'done')
    return (
      <Text size="xs" c="green">
        Done · {node.outputs} outputs
      </Text>
    );
  if (node.type === 'stop')
    return (
      <Text size="xs" c="red">
        Stopped: {node.issue.message}
      </Text>
    );
  if (node.type === 'workflow') {
    const { request } = node;
    return (
      <>
        <Text size="xs">
          {request.kind === 'image'
            ? `Image ×${request.quantity} from ${request.images.length} input(s): ${request.prompt}`
            : `Upscale ×${request.scale}`}
        </Text>
        <RemixGraphView node={node.next} />
      </>
    );
  }
  return (
    <>
      <Text size="xs">
        Ask ({node.spec.kind}): {node.spec.prompt}
      </Text>
      {node.branches.map(({ answer, next }) => (
        <div key={String(answer)} className="ml-3 border-l border-gray-4 pl-2 dark:border-dark-4">
          <Text size="xs" c="dimmed">
            → {String(answer)}
          </Text>
          <RemixGraphView node={next} />
        </div>
      ))}
    </>
  );
}
