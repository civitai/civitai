import { useState } from 'react';
import { useDebouncedValue } from '@mantine/hooks';
import { Card, Group, SegmentedControl, Stack, Text, TextInput, Title } from '@mantine/core';
import { ImportGroupList } from '~/components/Moderation/HuggingFaceImport/ImportGroupList';
import { useImportActions } from '~/components/Moderation/HuggingFaceImport/use-import-actions';
import { UnattachedSection } from '~/components/Moderation/HuggingFaceImport/UnattachedSection';
import { trpc } from '~/utils/trpc';

const ACTIVE = new Set(['Queued', 'Transferring']);

export function ImportQueueTable() {
  const [tab, setTab] = useState<'all' | 'unattached'>('all');
  const [groupFilter, setGroupFilter] = useState('');
  // Debounced so a keystroke is not a query; the filter is server-side because a client-side one
  // over a capped page silently stops finding older groups.
  const [debouncedFilter] = useDebouncedValue(groupFilter, 300);
  // Counts come from their own query: a page of rows cannot say how many exist outside it, which
  // is what the client-side filter got wrong. Filtered the same way the rows are, so a tab label
  // never counts a population the list beneath it is not showing.
  const { data: counts } = trpc.huggingFaceImport.getCounts.useQuery({
    groupName: debouncedFilter.trim() || undefined,
  });
  const { data = [], isLoading: isPending } = trpc.huggingFaceImport.getAll.useQuery(
    { limit: 100, groupName: debouncedFilter.trim() || undefined },
    {
      // A transfer advances a part at a time on a cron; polling is how the bar moves without a
      // websocket, and it stops as soon as nothing is in flight.
      refetchInterval: (query) =>
        query.state.data?.some((row) => ACTIVE.has(row.status)) ? 5000 : false,
    }
  );

  const actions = useImportActions(
    (id) => data.find((row) => row.id === id)?.filename ?? 'this import'
  );

  return (
    <Card withBorder padding="lg">
      <Stack gap="md">
        <Group justify="space-between" align="center" wrap="nowrap">
          <Group gap="lg" wrap="nowrap">
            <Title order={4}>Imports</Title>
            <SegmentedControl
              size="xs"
              value={tab}
              onChange={(value) => setTab(value as 'all' | 'unattached')}
              data={[
                { value: 'all', label: `All${counts ? ` (${counts.total})` : ''}` },
                {
                  value: 'unattached',
                  label: `Unattached${counts ? ` (${counts.unattached})` : ''}`,
                },
              ]}
            />
          </Group>
          <TextInput
            size="xs"
            w={260}
            placeholder="Filter by group name…"
            value={groupFilter}
            onChange={(event) => setGroupFilter(event.currentTarget.value)}
          />
        </Group>

        {tab === 'unattached' && <UnattachedSection filter={debouncedFilter} />}

        {tab === 'unattached' ? null : !data.length ? (
          <Text c="dimmed" size="sm">
            {isPending
              ? 'Loading…'
              : debouncedFilter.trim()
              ? `No imports match "${debouncedFilter.trim()}".`
              : 'Nothing imported yet.'}
          </Text>
        ) : (
          <ImportGroupList rows={data} actions={actions} />
        )}
      </Stack>
    </Card>
  );
}
