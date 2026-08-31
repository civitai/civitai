import {
  Badge,
  Center,
  Code,
  Group,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Text,
} from '@mantine/core';
import { diffWords } from 'diff';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

const actorRoleColors: Record<string, string> = {
  owner: 'blue',
  moderator: 'orange',
  system: 'gray',
};

// Values are JSON-encoded by the diff helper ('' = unset). Strings render bare;
// objects pretty-print so the word diff highlights the changed keys.
function decodeAuditValue(value: string) {
  if (value === '') return '';
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

// ClickHouse returns naive-UTC datetimes ('2026-07-29 12:00:00.000'); tag them as
// UTC so they don't parse as local time.
function parseChDate(value: string) {
  return new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
}

const addedStyle = { backgroundColor: 'rgba(46, 160, 67, 0.3)', borderRadius: 2 };
const removedStyle = {
  backgroundColor: 'rgba(248, 81, 73, 0.3)',
  borderRadius: 2,
  textDecoration: 'line-through',
};

function FieldDiff({ oldValue, newValue }: { oldValue: string; newValue: string }) {
  const oldText = decodeAuditValue(oldValue);
  const newText = decodeAuditValue(newValue);

  // Short scalar change: plain before → after reads better than a word diff.
  if (oldText.length <= 40 && newText.length <= 40 && !oldText.includes('\n')) {
    return (
      <Group gap={6} wrap="nowrap">
        <Text size="xs" span style={oldText ? removedStyle : undefined} px={oldText ? 4 : 0}>
          {oldText || '—'}
        </Text>
        <Text size="xs" span c="dimmed">
          →
        </Text>
        <Text size="xs" span style={newText ? addedStyle : undefined} px={newText ? 4 : 0}>
          {newText || '—'}
        </Text>
      </Group>
    );
  }

  const parts = diffWords(oldText, newText);
  return (
    <ScrollArea.Autosize mah={260}>
      <Text
        size="xs"
        component="pre"
        m={0}
        p={8}
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontFamily: 'var(--mantine-font-family-monospace)',
          backgroundColor: 'var(--mantine-color-default-hover)',
          borderRadius: 4,
        }}
      >
        {parts.map((part, i) => (
          <span key={i} style={part.added ? addedStyle : part.removed ? removedStyle : undefined}>
            {part.value}
          </span>
        ))}
      </Text>
    </ScrollArea.Autosize>
  );
}

// Mod-only change history for a model (entity-change audit log — see
// docs/entity-change-tracking-plan.md), grouped by save with per-field diffs.
// Latest 100 rows across the model + its versions + files; deep history lives in
// the Retool audit.changeHistory action.
export default function ModelChangeHistoryModal({ modelId }: { modelId: number }) {
  const dialog = useDialogContext();
  const { data, isLoading } = trpc.moderator.models.getChangeHistory.useQuery({ id: modelId });

  const batches: { batchId: string; rows: NonNullable<typeof data>['items'] }[] = [];
  for (const row of data?.items ?? []) {
    const last = batches[batches.length - 1];
    if (last?.batchId === row.batchId) last.rows.push(row);
    else batches.push({ batchId: row.batchId, rows: [row] });
  }

  return (
    <Modal {...dialog} title={<Text fw={600}>Change history</Text>} size="xl">
      {isLoading || !data ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : !data.items.length ? (
        <Text size="sm" c="dimmed" ta="center" py="xl">
          No recorded changes — the log starts when change tracking was enabled.
        </Text>
      ) : (
        <Stack gap="sm">
          {batches.map(({ batchId, rows }) => {
            const [first] = rows;
            const actor =
              data.usernames[first.userId] ??
              (first.actorRole === 'system' ? 'system' : `user #${first.userId}`);
            const entityLabel =
              first.entityType === 'Model'
                ? 'Model'
                : data.entityLabels[`${first.entityType}:${first.entityId}`] ??
                  `${first.entityType} #${first.entityId}`;
            return (
              <Paper key={batchId} withBorder radius="md" p="sm">
                <Stack gap={8}>
                  <Group gap={6} wrap="nowrap">
                    <Text size="xs" fw={600} style={{ whiteSpace: 'nowrap' }}>
                      {formatDate(parseChDate(first.createdAt), 'MMM D, YYYY h:mm A')}
                    </Text>
                    <Text size="xs">{actor}</Text>
                    <Badge
                      size="xs"
                      radius="xl"
                      variant="light"
                      color={actorRoleColors[first.actorRole] ?? 'gray'}
                    >
                      {first.actorRole}
                    </Badge>
                    {first.via !== 'web' && (
                      <Badge size="xs" radius="xl" variant="light" color="cyan">
                        {first.via}
                      </Badge>
                    )}
                    <Text size="xs" c="dimmed" truncate>
                      {entityLabel}
                    </Text>
                  </Group>
                  {rows.map((row, i) => (
                    <Stack key={i} gap={4}>
                      <Group gap={6}>
                        <Code fz={11}>{row.field}</Code>
                        {row.truncated ? (
                          <Badge size="xs" radius="xl" variant="light" color="gray">
                            truncated
                          </Badge>
                        ) : null}
                        {row.reason && (
                          <Badge size="xs" radius="xl" variant="light" color="yellow">
                            {row.reason}
                          </Badge>
                        )}
                      </Group>
                      <FieldDiff oldValue={row.oldValue} newValue={row.newValue} />
                    </Stack>
                  ))}
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      )}
    </Modal>
  );
}
