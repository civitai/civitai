import { useEffect, useState } from 'react';
import { Anchor, Button, Group, Paper, Radio, Stack, Text } from '@mantine/core';
import { oldestInactiveApp } from '~/components/Apps/AppAssistant/appLifecycle';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';
import { APP_STATUS, AppError } from '~/components/Apps/AppAssistant/YourApps';
import dayjs from '~/shared/utils/dayjs';

function usedLine(sandbox: Sandbox): string {
  const status = APP_STATUS[sandbox.state];
  return sandbox.lastActivityAt
    ? `${status} · last used ${dayjs(sandbox.lastActivityAt).fromNow()}`
    : status;
}

/**
 * After the last message once the assistant could not make an app because the user keeps as many as they
 * may: pick one to delete (the one used longest ago, not the open one, is chosen), and the request
 * that hit the limit continues by itself.
 */
export function FreeUpSlotCard({
  apps,
  openName,
  deleting,
  error,
  exporting,
  onExport,
  onDelete,
}: {
  apps: Sandbox[];
  /** The app open now, never chosen for the user. */
  openName: string | null;
  /** The delete the user confirmed is on its way. */
  deleting: boolean;
  error: unknown;
  /** The sandbox being exported (its name). */
  exporting: string | null;
  onExport: (sandbox: Sandbox) => void;
  onDelete: (sandbox: Sandbox) => void;
}) {
  const [picked, setPicked] = useState<string | null>(
    () => oldestInactiveApp(apps, openName)?.name ?? null
  );
  // An app gone from the list (deleted elsewhere) is not left chosen.
  useEffect(() => {
    if (!picked || !apps.some((s) => s.name === picked))
      setPicked(oldestInactiveApp(apps, openName)?.name ?? null);
  }, [apps, openName, picked]);
  const chosen = apps.find((s) => s.name === picked) ?? null;
  // Exporting a paused app starts it, which pauses the one that runs.
  const running = apps.find((s) => s.state !== 'suspended') ?? null;
  const exportPauses = running && apps.some((s) => s.state === 'suspended') ? running.app : null;

  return (
    <Paper component="section" aria-label="Free up a slot" withBorder radius="md" p="sm" mb="md">
      <Stack gap="xs">
        <div>
          <Text size="sm" fw={600}>
            Free up a slot
          </Text>
          <Text size="sm">
            You have as many apps as you can keep. Delete one and your request continues
            automatically.
          </Text>
        </div>
        <Radio.Group value={picked} onChange={setPicked} aria-label="App to delete">
          <Stack gap={6}>
            {apps.map((sandbox) => (
              <Group key={sandbox.name} justify="space-between" wrap="nowrap" gap="xs">
                <Radio
                  value={sandbox.name}
                  label={sandbox.app}
                  description={usedLine(sandbox)}
                  disabled={deleting}
                />
                <Anchor
                  component="button"
                  type="button"
                  size="xs"
                  className="min-h-11 shrink-0"
                  aria-label={`Export ${sandbox.app} first`}
                  disabled={!!exporting}
                  onClick={() => onExport(sandbox)}
                >
                  {exporting === sandbox.name ? 'Exporting…' : 'Export first'}
                </Anchor>
              </Group>
            ))}
          </Stack>
        </Radio.Group>
        {exportPauses && (
          <Text size="xs" c="dimmed">
            {`Exporting a paused app starts it, which pauses ${exportPauses}.`}
          </Text>
        )}
        <AppError error={error} />
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Text size="xs" c="dimmed">
            {deleting && chosen ? `Deleting ${chosen.app}…` : ''}
          </Text>
          <Button
            color="red"
            variant="light"
            className="min-h-11 shrink-0"
            loading={deleting}
            disabled={!chosen}
            onClick={() => chosen && onDelete(chosen)}
          >
            Delete and continue
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
