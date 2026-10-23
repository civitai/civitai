import { ActionIcon, Alert, Button, Group, Menu, Stack, Text, UnstyledButton } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import {
  IconDotsVertical,
  IconDownload,
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

/** The apps' latest failure. A failed poll keeps the last list, so its error shows only when there is none. */
export function appsError({ list, open, suspend, remove }: SandboxesState): unknown {
  return open.error ?? suspend.error ?? remove.error ?? (list.data ? null : list.error);
}

export function AppError({ error }: { error: unknown }) {
  if (!error) return null;
  // openApp already suspends the others and retries, so this is the retry refused: another tab started one in between.
  if (isRunningLimit(error))
    return (
      <Alert color="yellow" variant="light" title="Only one app can run at a time">
        Another of your apps started at the same moment. Send your message again: starting this app
        pauses the others.
      </Alert>
    );
  if (error instanceof SandboxApiError && error.kind === 'limit')
    return (
      <Alert color="yellow" variant="light" title="You have as many apps as you can keep">
        Delete an app you no longer need from the app switcher at the top of the page, then try
        again.
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

/** The confirmation every delete of an app asks for first. */
export function confirmDeleteApp(app: string, onConfirm: () => void) {
  openConfirmModal({
    title: `Delete ${app}?`,
    children: (
      <Text size="sm">
        Everything in this app is deleted, including files the assistant has not shown you. This
        cannot be undone.
      </Text>
    ),
    labels: { confirm: 'Delete app', cancel: 'Keep it' },
    confirmProps: { color: 'red' },
    onConfirm,
  });
}

/** The app other than `sandbox` that runs (or is starting), which starting `sandbox` pauses. */
export function runningOtherApp(apps: Sandbox[], sandbox: Sandbox): Sandbox | null {
  return apps.find((s) => s.name !== sandbox.name && s.state !== 'suspended') ?? null;
}

interface AppActions {
  sandboxes: SandboxesState;
  onRemoved: (name: string) => void;
  /** Starts a paused app, pausing the one that runs. */
  onStart: (sandbox: Sandbox) => void;
  /** Downloads the app as a zip, starting it first when it is paused. */
  onExport: (sandbox: Sandbox) => void;
  /** The app being started (its key), for its menu's busy state. */
  starting: string | null;
  /** The sandbox being exported (its name), for its menu's busy state. */
  exporting: string | null;
}

/** Start, Pause, Export and Delete for one app. */
export function AppMenu({
  sandbox,
  sandboxes,
  onRemoved,
  onStart,
  onExport,
  starting,
  exporting,
}: AppActions & { sandbox: Sandbox }) {
  const { suspend, remove } = sandboxes;
  const confirmDelete = () =>
    confirmDeleteApp(sandbox.app, () =>
      remove.mutate(sandbox.name, { onSuccess: () => onRemoved(sandbox.name) })
    );
  const pauses = runningOtherApp(sandboxes.list.data ?? [], sandbox);

  return (
    // Inside the app list's popover: a portalled dropdown would count as a click outside it.
    <Menu position="bottom-end" withinPortal={false}>
      <Menu.Target>
        <ActionIcon
          size={44}
          variant="subtle"
          color="gray"
          aria-label={`Actions for ${sandbox.app}`}
          loading={
            (suspend.isPending && suspend.variables === sandbox.name) ||
            (remove.isPending && remove.variables === sandbox.name) ||
            starting === sandbox.app ||
            exporting === sandbox.name
          }
        >
          <IconDotsVertical size={18} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {sandbox.state === 'suspended' && (
          <Menu.Item leftSection={<IconPlayerPlay size={16} />} onClick={() => onStart(sandbox)}>
            <Text component="span" size="sm" display="block">
              Start
            </Text>
            {pauses && (
              <Text component="span" size="xs" c="dimmed" display="block">
                {`${pauses.app} will be paused`}
              </Text>
            )}
          </Menu.Item>
        )}
        {sandbox.state !== 'suspended' && (
          <Menu.Item
            leftSection={<IconPlayerPause size={16} />}
            onClick={() => suspend.mutate(sandbox.name)}
          >
            Pause
          </Menu.Item>
        )}
        <Menu.Item leftSection={<IconDownload size={16} />} onClick={() => onExport(sandbox)}>
          <Text component="span" size="sm" display="block">
            Export
          </Text>
          <Text component="span" size="xs" c="dimmed" display="block">
            Download as zip
          </Text>
        </Menu.Item>
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

/** The user's apps: open one, start a new one, or start, pause, export or delete one from its menu. */
export function YourAppsList({
  sandboxes,
  activeName,
  onOpen,
  onNewApp,
  ...actions
}: AppActions & {
  activeName: string | null;
  onOpen: (sandbox: Sandbox) => void;
  onNewApp: () => void;
}) {
  const apps = sandboxes.list.data ?? [];

  return (
    <Stack gap="md">
      <Button
        variant="light"
        leftSection={<IconPlus size={16} />}
        className="min-h-11"
        onClick={onNewApp}
      >
        New app
      </Button>
      <AppError error={appsError(sandboxes)} />
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
                onClick={() => onOpen(sandbox)}
              >
                <Text fw={600} truncate>
                  {sandbox.app}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {isActive ? `Open now · ${statusLine(sandbox)}` : statusLine(sandbox)}
                </Text>
              </UnstyledButton>
              <AppMenu sandbox={sandbox} sandboxes={sandboxes} {...actions} />
            </Group>
          );
        })}
      </Stack>
      <Text size="xs" c="dimmed">
        You can keep 3 apps, and one runs at a time: picking a paused app, or sending it a message,
        starts it and pauses the one that runs. An app also pauses after 30 minutes idle or 8 hours
        running, and is deleted after 14 days unused.
      </Text>
    </Stack>
  );
}
