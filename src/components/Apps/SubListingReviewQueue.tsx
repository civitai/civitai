import {
  Anchor,
  Badge,
  Button,
  Center,
  Group,
  Image,
  Loader,
  Modal,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { Fragment, useState } from 'react';
import Link from 'next/link';
import { ModQueryError, isModAuthzError } from '~/components/Apps/ModQuerySurface';
import {
  ReasonGatedField,
  ReasonGatedSubmitButton,
  reasonMeetsMin,
} from '~/components/Apps/ReasonGatedActionModal';
import {
  AppsTableColgroup,
  APPS_SUB_LISTING_QUEUE_COLUMNS,
} from '~/components/Apps/appsWideLayout';
import { getListingDetailHref } from '~/components/Apps/appListingCardView';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type {
  ListSubListingQueueInput,
  SubListingModAction,
} from '~/server/schema/blocks/app-sub-listing.schema';
import type { RouterOutput } from '~/types/router';
import { APP_SUB_LISTING_REASON_MAX } from '~/shared/constants/app-sub-listing.constants';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type QueueRow = RouterOutput['appListings']['listSubListingQueue']['items'][number];
type Content = QueueRow['live'];
type View = ListSubListingQueueInput['view'];

const VIEW_OPTIONS: { value: View; label: string }[] = [
  { value: 'queue', label: 'Needs review' },
  { value: 'approved', label: 'Approved' },
  { value: 'hidden', label: 'Hidden' },
];

const ACTION_LABELS: Record<SubListingModAction, string> = {
  approve: 'Approve',
  hide: 'Hide',
  restore: 'Restore',
  'approve-edit': 'Approve edit',
  'reject-edit': 'Reject edit',
};

/** Actions that open a reason prompt before they run. */
const NEEDS_REASON = new Set<SubListingModAction>(['hide', 'reject-edit']);

/** The actions a row offers, from its state. */
export function subListingRowActions(
  row: Pick<QueueRow, 'status' | 'pending'>
): SubListingModAction[] {
  if (row.status === 'hidden') return ['restore'];
  if (row.status === 'pending') return ['approve', 'hide'];
  if (row.status === 'approved')
    return row.pending ? ['approve-edit', 'reject-edit', 'hide'] : ['hide'];
  return [];
}

const FIELDS: { key: keyof Content; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'tagline', label: 'Tagline' },
  { key: 'subPath', label: 'Path' },
  { key: 'contentRating', label: 'Rating' },
  { key: 'imageUrl', label: 'Image' },
];

/** The fields a staged edit changes, live value first. */
export function subListingEditDiff(live: Content, pending: Content) {
  return FIELDS.filter(({ key }) => (live[key] ?? null) !== (pending[key] ?? null)).map(
    ({ key, label }) => ({ key, label, before: live[key] ?? null, after: pending[key] ?? null })
  );
}

/** Delivery width for the 96px queue thumbnail: the first edge-ladder rung at or above 2x. */
const QUEUE_IMAGE_WIDTH = 320;

function FieldValue({ field, value }: { field: keyof Content; value: unknown }) {
  if (value == null || value === '')
    return (
      <Text size="sm" c="dimmed">
        —
      </Text>
    );
  if (field === 'imageUrl') {
    // `imageUrl` is the stored image KEY, not a URL: resolve it through the edge.
    return (
      <Image
        src={getEdgeUrl(String(value), { width: QUEUE_IMAGE_WIDTH })}
        alt=""
        w={96}
        h={54}
        fit="cover"
        radius="sm"
      />
    );
  }
  return <Text size="sm">{String(value)}</Text>;
}

function RowContent({ row }: { row: QueueRow }) {
  if (!row.pending) {
    return (
      <Stack gap={2}>
        <Text fw={600}>{row.live.title}</Text>
        {row.live.tagline && (
          <Text size="sm" c="dimmed">
            {row.live.tagline}
          </Text>
        )}
        <Text size="xs" c="dimmed">
          /{row.live.subPath}
          {row.live.contentRating ? ` · ${row.live.contentRating}` : ''}
        </Text>
        {row.live.imageUrl && <FieldValue field="imageUrl" value={row.live.imageUrl} />}
      </Stack>
    );
  }
  const diff = subListingEditDiff(row.live, row.pending);
  return (
    <Stack gap={4} data-testid="sub-listing-edit-diff">
      <Text fw={600}>{row.live.title}</Text>
      <Badge color="yellow" variant="light" size="xs" style={{ alignSelf: 'flex-start' }}>
        Edit waiting for review
      </Badge>
      <SimpleGrid cols={3} spacing="xs" verticalSpacing={4}>
        <span />
        <Text size="xs" fw={600}>
          Live
        </Text>
        <Text size="xs" fw={600}>
          Proposed
        </Text>
        {diff.map((d) => (
          <Fragment key={d.key}>
            <Text size="xs" c="dimmed">
              {d.label}
            </Text>
            <div data-testid={`sub-listing-diff-${d.key}`}>
              <FieldValue field={d.key} value={d.before} />
            </div>
            <div data-testid={`sub-listing-diff-${d.key}-proposed`}>
              <FieldValue field={d.key} value={d.after} />
            </div>
          </Fragment>
        ))}
      </SimpleGrid>
    </Stack>
  );
}

export function SubListingReviewQueue() {
  const [view, setView] = useState<View>('queue');
  const [prompt, setPrompt] = useState<{ row: QueueRow; action: SubListingModAction } | null>(null);
  const [reason, setReason] = useState('');
  const utils = trpc.useUtils();
  const query = trpc.appListings.listSubListingQueue.useQuery(
    { view, limit: 50 },
    { retry: false }
  );
  const moderate = trpc.appListings.moderateSubListing.useMutation({
    onSuccess: async (_data, input) => {
      showSuccessNotification({ message: `${ACTION_LABELS[input.action]}: done` });
      setPrompt(null);
      setReason('');
      await Promise.all([
        utils.appListings.listSubListingQueue.invalidate(),
        utils.appListings.countSubListingQueue.invalidate(),
      ]);
    },
    onError: (error) => {
      showErrorNotification({ title: 'Action failed', error });
      // A conflict means the row changed under the moderator; show them the current version.
      void utils.appListings.listSubListingQueue.invalidate();
    },
  });

  function act(row: QueueRow, action: SubListingModAction) {
    if (NEEDS_REASON.has(action)) {
      setPrompt({ row, action });
      return;
    }
    moderate.mutate({ id: row.id, action, version: row.version });
  }

  if (query.error && isModAuthzError(query.error)) return null;

  return (
    <Stack gap="md" data-testid="sub-listing-review-queue">
      <SegmentedControl
        value={view}
        onChange={(v) => setView(v as View)}
        data={VIEW_OPTIONS}
        style={{ alignSelf: 'flex-start' }}
      />
      {query.isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : query.error ? (
        <ModQueryError
          error={query.error}
          onRetry={() => query.refetch()}
          isRetrying={query.isFetching}
          title="Couldn’t load store items"
        />
      ) : !query.data?.items.length ? (
        <Text c="dimmed" py="lg" ta="center">
          Nothing here.
        </Text>
      ) : (
        <Table verticalSpacing="sm">
          <AppsTableColgroup columns={APPS_SUB_LISTING_QUEUE_COLUMNS} />
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Item</Table.Th>
              <Table.Th>App</Table.Th>
              <Table.Th>Author</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {query.data.items.map((row) => (
              <Table.Tr key={row.id} data-testid="sub-listing-row" data-status={row.status}>
                <Table.Td>
                  <RowContent row={row} />
                  {row.statusReason && (
                    <Text size="xs" c="red">
                      {row.statusReason}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Anchor component={Link} href={getListingDetailHref(row.parent.slug)} size="sm">
                    {row.parent.name}
                  </Anchor>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{row.author.username ?? `#${row.author.id}`}</Text>
                </Table.Td>
                <Table.Td>
                  <Group gap="xs" justify="flex-end" wrap="nowrap">
                    {subListingRowActions(row).map((action) => (
                      <Button
                        key={action}
                        size="xs"
                        variant={
                          action === 'approve' || action === 'approve-edit' ? 'filled' : 'default'
                        }
                        color={action === 'hide' || action === 'reject-edit' ? 'red' : undefined}
                        loading={moderate.isPending && moderate.variables?.id === row.id}
                        onClick={() => act(row, action)}
                      >
                        {ACTION_LABELS[action]}
                      </Button>
                    ))}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      <Modal
        opened={prompt != null}
        onClose={() => setPrompt(null)}
        title={prompt ? `${ACTION_LABELS[prompt.action]}: ${prompt.row.live.title}` : ''}
      >
        <Stack gap="sm">
          <ReasonGatedField
            label={prompt?.action === 'hide' ? 'Reason (shown to the author)' : 'Reason'}
            value={reason}
            onChange={setReason}
            required={prompt?.action === 'hide'}
            maxLength={APP_SUB_LISTING_REASON_MAX}
            minRows={2}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setPrompt(null)}>
              Cancel
            </Button>
            <ReasonGatedSubmitButton
              color="red"
              busy={moderate.isPending}
              gateOpen={prompt?.action !== 'hide' || reasonMeetsMin(reason)}
              label={prompt ? ACTION_LABELS[prompt.action] : ''}
              onClick={() =>
                prompt &&
                moderate.mutate({
                  id: prompt.row.id,
                  action: prompt.action,
                  version: prompt.row.version,
                  reason: reason.trim() || undefined,
                })
              }
            />
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
