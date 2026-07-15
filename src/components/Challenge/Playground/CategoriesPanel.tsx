import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Flex,
  Group,
  NumberInput,
  ScrollArea,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import type { ChallengeCategoryRow } from '~/server/services/challenge-category.service';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { PLAYGROUND_PANEL_HEIGHT } from './playground.constants';

type Draft = {
  key: string;
  label: string;
  group: string;
  criteria: string;
  rubric: string;
  rubricNsfw: string;
  sortOrder: number;
  active: boolean;
  isNew: boolean;
};

const blank: Draft = {
  key: '',
  label: '',
  group: 'Universal',
  criteria: '',
  rubric: '',
  rubricNsfw: '',
  sortOrder: 0,
  active: true,
  isNew: true,
};

// An existing library row → an editable draft (form-coerces the nullable rubric fields to '',
// locks the key). Used by both the save-success reload and the list-item selection.
const rowToDraft = (c: ChallengeCategoryRow): Draft => ({
  key: c.key,
  label: c.label,
  group: c.group,
  criteria: c.criteria,
  rubric: c.rubric ?? '',
  rubricNsfw: c.rubricNsfw ?? '',
  sortOrder: c.sortOrder,
  active: c.active,
  isNew: false,
});

export function CategoriesPanel() {
  const queryUtils = trpc.useUtils();
  const { data: categories, isLoading } = trpc.challenge.getChallengeCategories.useQuery();
  const [draft, setDraft] = useState<Draft | null>(null);

  const upsert = trpc.challenge.upsertChallengeCategory.useMutation({
    onSuccess: async (row) => {
      await queryUtils.challenge.getChallengeCategories.invalidate();
      // Reload the saved row as a non-new draft so the key locks and a second Save updates
      // (not re-creates) the same row.
      setDraft(rowToDraft(row));
      showSuccessNotification({ message: 'Category saved' });
    },
    onError: (error) => showErrorNotification({ error: new Error(error.message) }),
  });

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const save = () => {
    if (!draft) return;
    // key/label/group/criteria are trimmed by the zod schema; rubric fields need explicit ''→null.
    upsert.mutate({
      key: draft.key,
      label: draft.label,
      group: draft.group,
      criteria: draft.criteria,
      rubric: draft.rubric.trim() || null,
      rubricNsfw: draft.rubricNsfw.trim() || null,
      sortOrder: draft.sortOrder,
      active: draft.active,
    });
  };

  return (
    <Flex h={PLAYGROUND_PANEL_HEIGHT} gap={0} style={{ overflow: 'hidden' }}>
      <Card
        withBorder
        radius={0}
        p={0}
        h="100%"
        style={{ width: 280, minWidth: 280, borderRight: 0, overflow: 'hidden' }}
      >
        <Stack gap={0} h="100%">
          <Group justify="space-between" p="sm">
            <Text fw={600}>Categories</Text>
            <ActionIcon variant="light" onClick={() => setDraft({ ...blank })} title="Add category">
              <IconPlus size={16} />
            </ActionIcon>
          </Group>
          <ScrollArea style={{ flex: 1 }}>
            <Stack gap={0}>
              {isLoading && (
                <Text c="dimmed" p="sm" size="sm">
                  Loading…
                </Text>
              )}
              {categories?.map((c) => (
                <Group
                  key={c.key}
                  justify="space-between"
                  p="sm"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setDraft(rowToDraft(c))}
                >
                  <div>
                    <Text size="sm">{c.label}</Text>
                    <Text size="xs" c="dimmed">
                      {c.key} · {c.group}
                    </Text>
                  </div>
                  {!c.active && (
                    <Badge size="xs" color="gray">
                      off
                    </Badge>
                  )}
                </Group>
              ))}
            </Stack>
          </ScrollArea>
        </Stack>
      </Card>

      <Card
        withBorder
        radius={0}
        p="md"
        h="100%"
        style={{ flex: 1, minWidth: 0, overflow: 'auto' }}
      >
        {!draft ? (
          <Text c="dimmed">Select a category or add a new one.</Text>
        ) : (
          <Stack>
            <TextInput
              label="Key"
              description="Stable id, e.g. dread. Cannot be changed after creation."
              value={draft.key}
              disabled={!draft.isNew}
              onChange={(e) => set({ key: e.currentTarget.value })}
            />
            <TextInput
              label="Label"
              value={draft.label}
              onChange={(e) => set({ label: e.currentTarget.value })}
            />
            <TextInput
              label="Group"
              value={draft.group}
              onChange={(e) => set({ group: e.currentTarget.value })}
            />
            <Textarea
              label="Criteria (client-visible one-liner)"
              autosize
              minRows={2}
              value={draft.criteria}
              onChange={(e) => set({ criteria: e.currentTarget.value })}
            />
            <Textarea
              label="Rubric (server-only scoring block)"
              autosize
              minRows={4}
              value={draft.rubric}
              onChange={(e) => set({ rubric: e.currentTarget.value })}
            />
            <Textarea
              label="Rubric NSFW (optional override)"
              autosize
              minRows={4}
              value={draft.rubricNsfw}
              onChange={(e) => set({ rubricNsfw: e.currentTarget.value })}
            />
            <NumberInput
              label="Sort order"
              value={draft.sortOrder}
              onChange={(v) => set({ sortOrder: typeof v === 'number' ? v : 0 })}
            />
            <Switch
              label="Active"
              checked={draft.active}
              disabled={draft.key === 'theme'}
              onChange={(e) => set({ active: e.currentTarget.checked })}
            />
            <Group>
              <Button onClick={save} loading={upsert.isPending} disabled={!draft.key.trim()}>
                Save
              </Button>
              <Button variant="default" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </Group>
          </Stack>
        )}
      </Card>
    </Flex>
  );
}
