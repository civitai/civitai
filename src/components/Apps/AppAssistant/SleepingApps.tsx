import { ActionIcon, Alert, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconDotsVertical, IconTrash } from '@tabler/icons-react';
import {
  keptAppsOf,
  keptReason,
  safeOldest,
  sleepingLimitOldestOf,
  wakeOnlyFailure,
  type SleepingApp,
} from '@civitai/app-assistant';
import { Menu } from '~/components/MantineOverlays';
import { AppError, confirmDeleteApp } from '~/components/Apps/AppAssistant/YourApps';
import { SandboxApiError } from '~/components/Apps/AppAssistant/sandboxClient';
import dayjs from '~/shared/utils/dayjs';

/**
 * APP HIBERNATE on the page (the `app-hibernate` flag on): sleeping apps in the app list, the
 * Wake action, and the offers to delete the oldest sleeping app when the user is at their limit.
 * Nothing here deletes an app without the user's click on a confirmation.
 */

export const SLEEPING_STATUS = 'Sleeping';

/** A sleeping app's status line. */
export function sleepingLine(app: SleepingApp): string {
  const used = app.lastActivityAt ?? app.hibernatedAt;
  return `${SLEEPING_STATUS} · last used ${dayjs(used).fromNow()}`;
}

/**
 * The confirmation before the oldest sleeping app is deleted to make room. `then` says what
 * carries on once it is gone ("Your request continues", "tip-calculator wakes").
 */
export function confirmDeleteOldest(oldest: string, then: string, onConfirm: () => void) {
  openConfirmModal({
    title: `Delete ${oldest}?`,
    children: (
      <Text size="sm">
        {`${oldest} is your oldest sleeping app. It and its files are deleted for good, and this cannot be undone. ${then}`}
      </Text>
    ),
    labels: { confirm: `Delete ${oldest}`, cancel: 'Keep it' },
    confirmProps: { color: 'red' },
    onConfirm,
  });
}

/** One sleeping app in the list: Wake, and Delete app in its menu. */
export function SleepingAppRow({
  app,
  waking,
  busy,
  onWake,
  onDelete,
}: {
  app: SleepingApp;
  /** This app is being woken. */
  waking: boolean;
  /** This app is being deleted. */
  busy: boolean;
  onWake: (app: string) => void;
  onDelete: (app: string) => void;
}) {
  return (
    <Group component="li" wrap="nowrap" gap={4} className="rounded-md pl-3">
      <div className="min-h-11 min-w-0 flex-1 py-1">
        <Text fw={600} truncate>
          {app.app}
        </Text>
        <Text size="xs" c="dimmed" truncate>
          {sleepingLine(app)}
        </Text>
      </div>
      <Button
        size="compact-sm"
        variant="light"
        className="min-h-11 shrink-0"
        aria-label={`Wake ${app.app}`}
        loading={waking}
        disabled={busy}
        onClick={() => onWake(app.app)}
      >
        Wake
      </Button>
      {/* Inside the app list's popover: a portalled dropdown would count as a click outside it. */}
      <Menu position="bottom-end" withinPortal={false}>
        <Menu.Target>
          <ActionIcon
            size={44}
            variant="subtle"
            color="gray"
            aria-label={`Actions for ${app.app}`}
            loading={busy}
          >
            <IconDotsVertical size={18} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            color="red"
            leftSection={<IconTrash size={16} />}
            onClick={() => confirmDeleteApp(app.app, () => onDelete(app.app))}
          >
            Delete app
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

/**
 * Why a wake, a Put to sleep or a delete of `app` failed, under the list. At the sleeping-app limit it
 * offers to delete the oldest sleeping app, then tries again (`onDeleteOldest`); when the only apps
 * that could make room cannot be put to sleep, it says which and why.
 */
export function AppActionError({
  action,
  app,
  error,
  deleting,
  liveApps,
  sleepingApps,
  onDeleteOldest,
}: {
  /** What failed: waking `app`, putting it to sleep, or deleting it (a sleeping one). */
  action: 'wake' | 'sleep' | 'delete';
  app: string;
  error: unknown;
  deleting: boolean;
  /** The apps awake now: never offered for deletion. */
  liveApps: readonly string[];
  /** The sleeping apps the list shows, named when no delete can be offered. */
  sleepingApps: readonly string[];
  onDeleteOldest: (oldest: string) => void;
}) {
  const atLimit = error instanceof SandboxApiError && error.code === 'sleeping_limit';
  // 🔴 Never the app being woken (civitai keeps a woken app's record), nor any app awake now.
  const oldest = atLimit ? safeOldest(sleepingLimitOldestOf(error), { app, live: liveApps }) : null;
  if (atLimit && !oldest) return <SleepingFull sleepingApps={sleepingApps} />;
  if (oldest)
    return (
      <Alert color="yellow" variant="light" title="You have as many sleeping apps as you can keep">
        <Stack gap="xs">
          <Text size="sm">
            {`Delete your oldest sleeping app, ${oldest}, to make room${
              action === 'wake' ? `, and ${app} wakes` : `, and ${app} goes to sleep`
            }.`}
          </Text>
          <Button
            color="red"
            variant="light"
            className="min-h-11 self-start"
            loading={deleting}
            onClick={() =>
              confirmDeleteOldest(
                oldest,
                action === 'wake' ? `Then ${app} wakes.` : `Then ${app} goes to sleep.`,
                () => onDeleteOldest(oldest)
              )
            }
          >
            {`Delete ${oldest} to continue`}
          </Button>
        </Stack>
      </Alert>
    );
  const kept = keptAppsOf(error);
  if (kept)
    return (
      <Alert color="yellow" variant="light" title="You have as many apps as you can keep">
        <Text size="sm">
          {`None of your apps could be put to sleep to make room: ${kept
            .map((k) => `${k.app} ${keptReason(k.reason)}`)
            .join('; ')}. Delete one of your apps, then try again.`}
        </Text>
      </Alert>
    );
  const wakeOnly = wakeOnlyFailure(error);
  if (wakeOnly)
    return (
      <Alert color="red" variant="light">
        {wakeOnly}
      </Alert>
    );
  if (action === 'sleep' && error instanceof SandboxApiError && error.status === 409 && error.code)
    return (
      <Alert color="yellow" variant="light">
        {`${app} can’t be put to sleep right now. It stays as it is.`}
      </Alert>
    );
  return <AppError error={error} />;
}

/**
 * Under the chat, once the assistant could not make or wake an app because the user's sleeping
 * apps are at their limit: delete the oldest (named by the refusal), and the request that hit the
 * limit continues by itself. Nothing is deleted until the user confirms.
 */
export function SleepingLimitCard({
  oldest,
  sleepingApps,
  deleting,
  error,
  onDelete,
}: {
  /** The oldest sleeping app to offer, or `null` when none is safe to offer (see `safeOldest`). */
  oldest: string | null;
  sleepingApps: readonly string[];
  deleting: boolean;
  error: unknown;
  onDelete: (oldest: string) => void;
}) {
  if (!oldest)
    return (
      <Paper
        component="section"
        aria-label="Make room for this app"
        withBorder
        radius="md"
        p="sm"
        mb="md"
      >
        <SleepingFull sleepingApps={sleepingApps} />
      </Paper>
    );
  return (
    <Paper
      component="section"
      aria-label="Make room for this app"
      withBorder
      radius="md"
      p="sm"
      mb="md"
    >
      <Stack gap="xs">
        <div>
          <Text size="sm" fw={600}>
            Make room for this app
          </Text>
          <Text size="sm">
            {`You have as many sleeping apps as you can keep. Delete your oldest, ${oldest}, and your request continues automatically.`}
          </Text>
        </div>
        <AppError error={error} />
        <Group justify="flex-end">
          <Button
            color="red"
            variant="light"
            className="min-h-11"
            loading={deleting}
            onClick={() =>
              confirmDeleteOldest(oldest, 'Your request then continues.', () => onDelete(oldest))
            }
          >
            {`Delete ${oldest} to continue`}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

/**
 * At the sleeping-app limit with no app safe to offer for deletion: the user is told to delete a
 * sleeping app themselves (each Sleeping row has Delete app), and which ones they have.
 */
function SleepingFull({ sleepingApps }: { sleepingApps: readonly string[] }) {
  return (
    <Alert color="yellow" variant="light" title="You have as many sleeping apps as you can keep">
      <Text size="sm">
        {`Delete a sleeping app you no longer need first, from the app switcher at the top of the page, then try again.${
          sleepingApps.length ? ` Your sleeping apps: ${sleepingApps.join(', ')}.` : ''
        }`}
      </Text>
    </Alert>
  );
}
