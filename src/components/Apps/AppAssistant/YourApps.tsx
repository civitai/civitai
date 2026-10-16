import { ActionIcon, Alert, Button, Group, Menu, Stack, Text, UnstyledButton } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import {
  IconDotsVertical,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import { SandboxApiError, isRunningLimit } from '~/components/Apps/AppAssistant/sandboxClient';
import type { SandboxesState } from '~/components/Apps/AppAssistant/useSandboxes';
import dayjs from '~/shared/utils/dayjs';

export const APP_STATUS: Record<Sandbox['state'], string> = {
  running: 'Running',
  starting: 'Starting…',
  suspended: 'Paused',
};

export function AppError({ error }: { error: unknown }) {
  if (!error) return null;
  // openApp already suspends the others and retries, so this is the retry refused: another tab started one in between.
  if (isRunningLimit(error))
    return (
      <Alert color="yellow" variant="light" title="Only one app can run at a time">
        Pause your other app under Your apps, then try again.
      </Alert>
    );
  if (error instanceof SandboxApiError && error.kind === 'limit')
    return (
      <Alert color="yellow" variant="light" title="You have as many apps as you can keep">
        Delete an app you no longer need under Your apps, then try again.
      </Alert>
    );
  if (error instanceof SandboxApiError && error.kind === 'conflict')
    return (
      <Alert color="yellow" variant="light">
        That app was changing at the same moment. Try again.
      </Alert>
    );
  return (
    <Alert color="red" variant="light">
      {error instanceof Error && !(error instanceof SandboxApiError)
        ? error.message
        : 'Your apps could not be reached right now. Try again in a moment.'}
    </Alert>
  );
}

interface AppActions {
  sandboxes: SandboxesState;
  onOpen: (app: string) => void;
  onRemoved: (name: string) => void;
}

/** Pause, Resume and Delete for one app. */
export function AppMenu({
  sandbox,
  sandboxes,
  onOpen,
  onRemoved,
}: AppActions & { sandbox: Sandbox }) {
  const { suspend, remove } = sandboxes;
  const confirmDelete = () =>
    openConfirmModal({
      title: `Delete ${sandbox.app}?`,
      children: (
        <Text size="sm">
          Everything in this app is deleted, including files the assistant has not shown you. This
          cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Delete app', cancel: 'Keep it' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate(sandbox.name, { onSuccess: () => onRemoved(sandbox.name) }),
    });

  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          size={44}
          variant="subtle"
          color="gray"
          aria-label={`Actions for ${sandbox.app}`}
          loading={
            (suspend.isPending && suspend.variables === sandbox.name) ||
            (remove.isPending && remove.variables === sandbox.name)
          }
        >
          <IconDotsVertical size={18} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {sandbox.state === 'suspended' ? (
          <Menu.Item leftSection={<IconPlayerPlay size={16} />} onClick={() => onOpen(sandbox.app)}>
            Resume
          </Menu.Item>
        ) : (
          <Menu.Item
            leftSection={<IconPlayerPause size={16} />}
            onClick={() => suspend.mutate(sandbox.name)}
          >
            Pause
          </Menu.Item>
        )}
        <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={confirmDelete}>
          Delete app
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

function statusLine(sandbox: Sandbox): string {
  const status = APP_STATUS[sandbox.state];
  return sandbox.state === 'suspended' && sandbox.expiresAt
    ? `${status} · deleted ${dayjs(sandbox.expiresAt).fromNow()} if unused`
    : status;
}

/** The user's apps: open one, start a new one, or pause, resume or delete one from its menu. */
export function YourAppsList({
  sandboxes,
  activeName,
  onOpen,
  onRemoved,
  onNewApp,
}: AppActions & { activeName: string | null; onNewApp: () => void }) {
  const { list, open, suspend, remove } = sandboxes;
  const apps = list.data ?? [];

  return (
    <Stack gap="md">
      <Button
        variant="light"
        leftSection={<IconPlus size={16} />}
        className="min-h-11"
        onClick={onNewApp}
      >
        Start a new app
      </Button>
      <AppError error={open.error ?? suspend.error ?? remove.error ?? list.error} />
      <Stack gap={4} component="ul" className="m-0 list-none p-0">
        {apps.map((sandbox) => {
          const isActive = sandbox.name === activeName;
          return (
            <Group
              key={sandbox.name}
              component="li"
              wrap="nowrap"
              gap={4}
              className={clsx('rounded-md pl-3', isActive && 'bg-gray-1 dark:bg-dark-5')}
            >
              <UnstyledButton
                className="min-h-11 min-w-0 flex-1 py-1"
                aria-current={isActive ? 'true' : undefined}
                onClick={() => onOpen(sandbox.app)}
              >
                <Text fw={600} truncate>
                  {sandbox.app}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {isActive ? `Open now · ${statusLine(sandbox)}` : statusLine(sandbox)}
                </Text>
              </UnstyledButton>
              <AppMenu
                sandbox={sandbox}
                sandboxes={sandboxes}
                onOpen={onOpen}
                onRemoved={onRemoved}
              />
            </Group>
          );
        })}
      </Stack>
      <Text size="xs" c="dimmed">
        You can keep 3 apps, and one runs at a time: opening another pauses the one that runs. An
        app also pauses after 30 minutes idle or 8 hours running, and is deleted after 14 days
        unused.
      </Text>
    </Stack>
  );
}
