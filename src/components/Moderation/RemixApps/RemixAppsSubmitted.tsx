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
import { REMIX_REJECT_REASONS, type RemixRejectReason } from '~/shared/remix-apps/row.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

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
        There is no step graph or preview yet: those come when the sandbox runner ships. Review the
        listing and the code itself. Until then a user app cannot run, approved or not.
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
    // The mod's own decision is what they saw next; a failure may still have saved one.
    onSuccess: (result) => {
      setSeen((s) => ({ ...s, review: result.review }));
      return onSuccess();
    },
    onError: (error) => {
      onError(error);
      return onSuccess();
    },
  });
  const setEnabled = trpc.remixApp.admin.setEnabled.useMutation({ onSuccess, onError });
  const clearMark = trpc.remixApp.admin.clearMinorThemed.useMutation({ onSuccess, onError });
  const marked = !!user.minorThemed;

  return (
    <Stack gap="xs" className="rounded-md border border-solid border-gray-3 p-3 dark:border-dark-4">
      <Group justify="space-between">
        <Group gap="xs">
          <Title order={4}>{seen.name}</Title>
          <Badge color={REVIEW_COLOR[user.review]}>{user.review}</Badge>
          {marked && <Badge color="red">minor-themed</Badge>}
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
      <Group justify="space-between" align="flex-end">
        <Group gap="xs" align="flex-end">
          <Checkbox
            label="Allow mature sources (adds the mature engine)"
            checked={mature && !marked}
            disabled={marked}
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
                mature: mature && !marked,
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
                {entry.at} · {entry.action} by {entry.by}
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
