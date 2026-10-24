import { Alert, Button, Center, Group, Loader, Stack, Text } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { DevTunnelBlockHost } from '~/components/AppBlocks/DevTunnelBlockHost';
import { DevTunnelDnsGate } from '~/components/AppBlocks/DevTunnelDnsGate';
import { fetchPreviewFrame } from '~/components/Apps/AppAssistant/previewFrame';
import type { PreviewSession } from '~/components/Apps/AppAssistant/previewTools';

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <Center className="h-full p-6">
      <Text size="sm" c="dimmed" ta="center" maw={360}>
        {children}
      </Text>
    </Center>
  );
}

export function AppAssistantPreview({
  canPreview,
  session,
}: {
  canPreview: boolean;
  session: PreviewSession | null;
}) {
  const frame = useQuery({
    // A new start (the page's own tunnel id, or the runner's next start) fetches a fresh frame.
    queryKey: ['app-assistant', 'preview', session?.blockId, session?.sessionId, session?.view],
    queryFn: () => fetchPreviewFrame((session as PreviewSession).blockId),
    enabled: !!session,
    // The entry token in `iframeSrc` is short-lived and used once, on load; never reuse an old one.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });

  if (!canPreview)
    return (
      <EmptyState>
        Live preview isn’t enabled for your account yet. The assistant can still build and test your
        app.
      </EmptyState>
    );
  if (!session)
    return (
      <EmptyState>
        Your app appears here once it runs. Ask the assistant to start the live preview.
      </EmptyState>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Group justify="space-between" px="sm" py={6} wrap="nowrap" className="shrink-0">
        <Text size="xs" c="dimmed" truncate>
          New previews can take a minute to appear.
        </Text>
        <Group gap={6} wrap="nowrap">
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={<IconRefresh size={14} />}
            loading={frame.isFetching}
            onClick={() => frame.refetch()}
          >
            Reload
          </Button>
        </Group>
      </Group>
      <div className="flex min-h-0 flex-1 flex-col">
        {frame.isLoading ? (
          <Center className="h-full">
            <Loader size="sm" />
          </Center>
        ) : frame.error || !frame.data ? (
          <Stack p="md">
            <Alert color="yellow" variant="light">
              {frame.error instanceof Error ? frame.error.message : 'The preview is unavailable'}
            </Alert>
          </Stack>
        ) : 'preparing' in frame.data ? (
          <DevTunnelDnsGate blockId={session.blockId} onSettled={() => frame.refetch()} />
        ) : (
          <DevTunnelBlockHost
            // A fresh entry URL is a fresh mount, so the host re-runs its handshake.
            key={frame.data.iframeSrc}
            {...frame.data}
            fit="fill"
            // The app reloaded itself (Vite live reload): the Reload button's own path. Not
            // `cancelRefetch`, so reports arriving mid-fetch join it rather than restart it.
            onGuestReloaded={() => void frame.refetch({ cancelRefetch: false })}
            tokenErrorFallback={
              <Stack p="md">
                <Alert color="red" variant="light">
                  The preview couldn’t sign in to your app. Reload, or ask the assistant to restart
                  the preview.
                </Alert>
              </Stack>
            }
          />
        )}
      </div>
    </div>
  );
}
