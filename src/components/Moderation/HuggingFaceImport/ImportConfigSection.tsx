import { Alert, Button, Card, Group, NumberInput, Stack, Switch, Text, Title } from '@mantine/core';
import { useEffect, useState } from 'react';
import { formatBytes } from '~/utils/number-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** Mirrors `PART_SIZE_BYTES`. Only used to show the operator what their numbers cost. */
const PART_SIZE = 16 * 1024 * 1024;
/**
 * Measured: RSS grows roughly twice the retained payload, because `arrayBuffer()` leaves undici's
 * concat buffer alive off-heap where it barely pressures GC. Showing the retained figure alone would
 * understate what a pod needs by half.
 */
const RESIDENT_MULTIPLIER = 2;

export function ImportConfigSection() {
  const queryUtils = trpc.useUtils();
  const { data: config } = trpc.huggingFaceImport.getConfig.useQuery();

  const [draft, setDraft] = useState<{
    enabled: boolean;
    filesInParallel: number;
    partsInFlight: number;
    workBudgetSeconds: number;
  } | null>(null);

  // Seeds ONCE, deliberately: re-seeding on every `config` change would discard edits in progress
  // the moment a background refetch landed. The cost is that a change made elsewhere is not picked
  // up until reload — acceptable for a panel one moderator opens at a time.
  useEffect(() => {
    if (config && !draft) setDraft({ ...config });
  }, [config, draft]);

  const save = trpc.huggingFaceImport.setConfig.useMutation({
    onSuccess: async (saved) => {
      setDraft({ ...saved });
      showSuccessNotification({ title: 'Saved', message: 'Applies from the next job tick.' });
      await queryUtils.huggingFaceImport.getConfig.invalidate();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not save', error: new Error(error.message) }),
  });

  // Rendering nothing while the query is in flight left a silent gap where the panel belongs, which
  // reads as "this page has no settings" rather than "not loaded yet".
  if (!draft)
    return (
      <Card withBorder padding="lg">
        <Stack gap="xs">
          <Title order={4}>Transfer settings</Title>
          <Text c="dimmed" size="sm">
            Loading…
          </Text>
        </Stack>
      </Card>
    );

  const residentBytes =
    draft.filesInParallel * draft.partsInFlight * PART_SIZE * RESIDENT_MULTIPLIER;
  const dirty =
    !!config &&
    (['enabled', 'filesInParallel', 'partsInFlight', 'workBudgetSeconds'] as const).some(
      (key) => draft[key] !== config[key]
    );

  return (
    <Card withBorder padding="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <Stack gap={2}>
            <Title order={4}>Transfer settings</Title>
            <Text c="dimmed" size="sm">
              Applies from the next job tick. Turning transfers off leaves queued files untouched.
            </Text>
          </Stack>
          <Switch
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.currentTarget.checked })}
            label={draft.enabled ? 'Transfers on' : 'Transfers off'}
          />
        </Group>

        <Group grow align="flex-start">
          <NumberInput
            label="Files at once"
            description="Across the whole fleet"
            min={1}
            max={4}
            value={draft.filesInParallel}
            onChange={(value) =>
              setDraft({ ...draft, filesInParallel: typeof value === 'number' ? value : 1 })
            }
          />
          <NumberInput
            label="Parts per file"
            description="Concurrent 16 MB reads"
            min={1}
            max={6}
            value={draft.partsInFlight}
            onChange={(value) =>
              setDraft({ ...draft, partsInFlight: typeof value === 'number' ? value : 1 })
            }
          />
          <NumberInput
            label="Seconds per run"
            description="Must stay inside the 5-minute lock"
            min={15}
            max={240}
            value={draft.workBudgetSeconds}
            onChange={(value) =>
              setDraft({ ...draft, workBudgetSeconds: typeof value === 'number' ? value : 120 })
            }
          />
        </Group>

        {/* The number these three knobs actually buy. Without it they read as speed dials, and the
            one that matters is memory on a pod that is also serving traffic. */}
        <Alert color={residentBytes > 400 * 1024 * 1024 ? 'orange' : 'gray'}>
          <Text size="sm">
            Roughly <strong>{formatBytes(residentBytes)}</strong> resident on the pod running the
            transfer — {draft.filesInParallel} × {draft.partsInFlight} × 16&nbsp;MB, doubled,
            because the fetch leaves a copy alive off-heap.
          </Text>
        </Alert>

        <Group justify="flex-end">
          <Button
            variant="default"
            disabled={!dirty}
            onClick={() => config && setDraft({ ...config })}
          >
            Reset
          </Button>
          <Button loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(draft)}>
            Save
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
