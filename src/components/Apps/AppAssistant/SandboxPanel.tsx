import type { FormEvent } from 'react';
import { useState } from 'react';
import { Alert, Badge, Button, Group, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { appKeyError, isAppBlockId } from '~/components/Apps/AppAssistant/appKey';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import { SandboxApiError } from '~/components/Apps/AppAssistant/sandboxClient';
import type { SandboxesState } from '~/components/Apps/AppAssistant/useSandboxes';
import dayjs from '~/shared/utils/dayjs';

const STATE_COLOR: Record<Sandbox['state'], string> = {
  running: 'green',
  starting: 'blue',
  suspended: 'gray',
};

export function SandboxError({ error }: { error: unknown }) {
  if (!error) return null;
  if (error instanceof SandboxApiError && error.kind === 'limit')
    return (
      <Alert color="yellow" variant="light" title="Sandbox limit reached">
        {error.message}. Suspend or delete a sandbox, then try again.
      </Alert>
    );
  if (error instanceof SandboxApiError && error.kind === 'conflict')
    return (
      <Alert color="yellow" variant="light">
        That sandbox was changing at the same moment. Try again.
      </Alert>
    );
  return (
    <Alert color="red" variant="light">
      {error instanceof Error ? error.message : 'The sandbox service did not respond.'}
    </Alert>
  );
}

export interface SandboxPanelProps {
  sandboxes: SandboxesState;
  activeName: string | null;
  onOpened: (sandbox: Sandbox) => void;
  onRemoved: (name: string) => void;
}

export function SandboxPanel({ sandboxes, activeName, onOpened, onRemoved }: SandboxPanelProps) {
  const { list, open, suspend, remove } = sandboxes;
  const [appKey, setAppKey] = useState('');
  const [touched, setTouched] = useState(false);
  const trimmed = appKey.trim();
  const keyError = appKeyError(trimmed);

  const openApp = (app: string) =>
    open.mutate(app, { onSuccess: ({ sandbox }) => onOpened(sandbox) });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (keyError) return;
    openApp(trimmed);
    setAppKey('');
    setTouched(false);
  };

  const confirmDelete = (sandbox: Sandbox) =>
    openConfirmModal({
      title: 'Delete this sandbox?',
      children: (
        <Text size="sm">
          Everything in <strong>{sandbox.app}</strong>&apos;s sandbox is deleted, including files
          the assistant has not shown you. This cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Delete sandbox', cancel: 'Keep it' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(sandbox.name, { onSuccess: () => onRemoved(sandbox.name) }),
    });

  const items = list.data ?? [];

  return (
    <Stack gap="md">
      <div>
        <Title order={4}>Sandboxes</Title>
        <Text size="sm" c="dimmed">
          Each app is built in its own sandbox. You can keep 3, and 1 can run at a time. A sandbox
          pauses after 30 minutes idle or 8 hours running, and is deleted after 14 days unused.
        </Text>
      </div>

      <form onSubmit={submit}>
        <Group align="flex-start" gap="xs" wrap="nowrap">
          <TextInput
            className="flex-1"
            aria-label="App name"
            placeholder="my-app"
            value={appKey}
            onChange={(e) => setAppKey(e.currentTarget.value)}
            onBlur={() => setTouched(trimmed.length > 0)}
            error={touched ? keyError : undefined}
            description={
              trimmed && !keyError && !isAppBlockId(trimmed)
                ? 'Live preview needs an app id like my-app; the assistant will choose one.'
                : 'Reusing a name reopens that app’s sandbox.'
            }
          />
          <Button type="submit" loading={open.isPending}>
            Open sandbox
          </Button>
        </Group>
      </form>

      <SandboxError error={open.error ?? suspend.error ?? remove.error ?? list.error} />

      {list.isLoading ? (
        <Text size="sm" c="dimmed">
          Loading your sandboxes…
        </Text>
      ) : items.length === 0 ? (
        <Text size="sm" c="dimmed">
          No sandboxes yet. Name your app above to start one.
        </Text>
      ) : (
        <Stack gap="xs">
          {items.map((sandbox) => {
            const isActive = sandbox.name === activeName;
            return (
              <Paper key={sandbox.name} withBorder p="sm" radius="md">
                <Group justify="space-between" wrap="nowrap" gap="sm">
                  <div className="min-w-0">
                    <Group gap="xs" wrap="nowrap">
                      <Text fw={600} truncate>
                        {sandbox.app}
                      </Text>
                      <Badge size="sm" variant="light" color={STATE_COLOR[sandbox.state]}>
                        {sandbox.state}
                      </Badge>
                    </Group>
                    <Text size="xs" c="dimmed" truncate>
                      {sandbox.name}
                      {sandbox.expiresAt
                        ? ` · deleted ${dayjs(sandbox.expiresAt).fromNow()} if unused`
                        : ''}
                    </Text>
                  </div>
                  <Group gap={6} wrap="nowrap">
                    <Button
                      size="compact-sm"
                      variant={isActive ? 'light' : 'filled'}
                      disabled={isActive}
                      loading={open.isPending && open.variables === sandbox.app}
                      onClick={() => openApp(sandbox.app)}
                    >
                      {isActive ? 'Open' : sandbox.state === 'suspended' ? 'Resume' : 'Open'}
                    </Button>
                    {sandbox.state !== 'suspended' && (
                      <Button
                        size="compact-sm"
                        variant="default"
                        loading={suspend.isPending && suspend.variables === sandbox.name}
                        onClick={() => suspend.mutate(sandbox.name)}
                      >
                        Suspend
                      </Button>
                    )}
                    <Button
                      size="compact-sm"
                      variant="subtle"
                      color="red"
                      loading={remove.isPending && remove.variables === sandbox.name}
                      onClick={() => confirmDelete(sandbox)}
                    >
                      Delete
                    </Button>
                  </Group>
                </Group>
              </Paper>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
