import { Button, Group, Paper, Stack, Text } from '@mantine/core';
import { AppError } from '~/components/Apps/AppAssistant/YourApps';

/**
 * Just above the chat's message box while the open app is paused: nothing starts it by itself (starting it pauses the
 * one that runs), so the user can, here. Follows the app while it starts, whoever started it.
 */
export function PausedAppNotice({
  app,
  starting,
  canStart,
  pending,
  pauses,
  error,
  onStart,
}: {
  app: string;
  /** The app is starting: by this notice, a held message, or anywhere else. */
  starting: boolean;
  /** Paused, and not being started by something other than this notice. */
  canStart: boolean;
  /** This notice's own start is on its way. */
  pending: boolean;
  /** The app that runs now, which starting this one pauses. */
  pauses: string | null;
  error: unknown;
  onStart: () => void;
}) {
  return (
    <Paper
      component="section"
      aria-label="App status"
      withBorder
      radius="md"
      px="sm"
      py="xs"
      mb={6}
    >
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <div className="min-w-0">
            <Text size="sm" fw={600}>
              {starting ? 'Starting…' : `${app} is paused.`}
            </Text>
            {!starting && pauses && (
              <Text size="xs" c="dimmed">
                {`Starting it pauses ${pauses}.`}
              </Text>
            )}
          </div>
          {canStart && (
            <Button
              size="compact-sm"
              className="min-h-11 shrink-0"
              loading={pending}
              onClick={onStart}
            >
              Start app
            </Button>
          )}
        </Group>
        {!starting && <AppError error={error} />}
      </Stack>
    </Paper>
  );
}
