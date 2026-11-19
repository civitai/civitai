import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Stack,
  Switch,
  Text,
  Title,
} from '@mantine/core';
import { useState } from 'react';
import type { AdminRow } from '~/components/Moderation/RemixApps/RemixAppsAdmin';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export type SubmittedRow = Extract<AdminRow, { user: unknown }>;

const REVIEW_COLOR = { submitted: 'yellow', approved: 'green', rejected: 'red' } as const;

/** User apps waiting on, or past, a mod's review of their code. */
export function RemixAppsSubmitted({ rows }: { rows: SubmittedRow[] }) {
  return (
    <Stack>
      <Alert color="blue">
        There is no step graph or preview yet: those come when the sandbox runner ships. Review the
        code itself. Until then a user app cannot run, approved or not.
      </Alert>
      {rows.length ? (
        rows.map((row) => <SubmittedApp key={row.slug} row={row} />)
      ) : (
        <Text c="dimmed">No user apps have been submitted.</Text>
      )}
    </Stack>
  );
}

function SubmittedApp({ row }: { row: SubmittedRow }) {
  const { user } = row;
  const [mature, setMature] = useState(user.mature);
  const utils = trpc.useUtils();
  const onError = (error: { message: string }) =>
    showErrorNotification({ title: 'Not saved', error: new Error(error.message) });
  const onSuccess = () => utils.remixApp.admin.list.invalidate();
  const review = trpc.remixApp.admin.review.useMutation({ onSuccess, onError });
  const setEnabled = trpc.remixApp.admin.setEnabled.useMutation({ onSuccess, onError });
  // The hash of the source on screen, so an approval never lands on code the mod did not read.
  const decide = (decision: 'approved' | 'rejected') =>
    review.mutate({ slug: row.slug, sha256: user.sha256, decision, mature });

  return (
    <Stack gap="xs" className="rounded-md border border-solid border-gray-3 p-3 dark:border-dark-4">
      <Group justify="space-between">
        <Group gap="xs">
          <Title order={4}>{user.name}</Title>
          <Badge color={REVIEW_COLOR[user.review]}>{user.review}</Badge>
          <Text size="sm" c="dimmed">
            {row.slug} · author {user.authorId}
          </Text>
        </Group>
        <Switch
          label="Enabled"
          checked={row.enabled}
          disabled={user.review !== 'approved' || setEnabled.isPending}
          onChange={(e) => setEnabled.mutate({ slug: row.slug, enabled: e.currentTarget.checked })}
        />
      </Group>
      {user.description && <Text size="sm">{user.description}</Text>}
      <Code block className="max-h-96 overflow-auto">
        {user.source}
      </Code>
      <Text size="xs" c="dimmed">
        sha256 {user.sha256}
      </Text>
      <Group justify="space-between">
        <Checkbox
          label="Allow mature sources (adds the mature engine)"
          checked={mature}
          onChange={(e) => setMature(e.currentTarget.checked)}
        />
        <Group gap="xs">
          <Button
            variant="light"
            color="red"
            loading={review.isPending}
            onClick={() => decide('rejected')}
          >
            Reject
          </Button>
          <Button loading={review.isPending} onClick={() => decide('approved')}>
            Approve
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}
