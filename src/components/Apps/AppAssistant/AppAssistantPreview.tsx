import { useEffect, useState } from 'react';
import { Alert, Button, Center, Group, Loader, Stack, Text } from '@mantine/core';
import { IconPlayerPlay, IconRefresh } from '@tabler/icons-react';
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

/** The server runner's Restart preview, as the workspace offers it for the open app. */
export interface PreviewRestart {
  onRestart: () => void;
  pending: boolean;
  /** Why the last restart failed, in words for the user. */
  error: string | null;
}

/** What the pane says when no preview of the open app is live (after a reload, say). */
export const NO_LIVE_PREVIEW = 'The live preview isn’t running.';
/** …and when the app's frame would not load. */
export const PREVIEW_NOT_LOADING = 'The preview isn’t loading.';

function RestartPreview({ restart, reason }: { restart: PreviewRestart; reason: string }) {
  return (
    <Stack gap="xs" align="center" p="md" data-testid="preview-restart">
      <Text size="sm" c="dimmed" ta="center">
        {reason}
      </Text>
      <Button
        size="compact-sm"
        variant="light"
        className="min-h-11"
        leftSection={<IconPlayerPlay size={14} />}
        loading={restart.pending}
        onClick={restart.onRestart}
      >
        Restart preview
      </Button>
      {restart.error && (
        <Alert color="yellow" variant="light" role="alert">
          {restart.error}
        </Alert>
      )}
    </Stack>
  );
}

export function AppAssistantPreview({
  canPreview,
  session,
  restart,
}: {
  canPreview: boolean;
  session: PreviewSession | null;
  /** On the server runner: the pane offers it when no preview is live, or the app will not load. */
  restart?: PreviewRestart;
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
  // The frame reached its host's terminal fallback (never ready, its token failed, a fatal error).
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [frame.data]);

  if (!canPreview)
    return (
      <EmptyState>
        Live preview isn’t enabled for your account yet. The assistant can still build and test your
        app.
      </EmptyState>
    );
  if (!session && restart)
    return (
      <Center className="h-full">
        <RestartPreview restart={restart} reason={NO_LIVE_PREVIEW} />
      </Center>
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
      {restart && failed && <RestartPreview restart={restart} reason={PREVIEW_NOT_LOADING} />}
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
            {restart && <RestartPreview restart={restart} reason={NO_LIVE_PREVIEW} />}
          </Stack>
        ) : 'preparing' in frame.data ? (
          <DevTunnelDnsGate blockId={session.blockId} onSettled={() => frame.refetch()} />
        ) : (
          <DevTunnelBlockHost
            onFallbackChange={(reason) => setFailed(!!reason)}
            // A fresh entry URL is a fresh mount, so the host re-runs its handshake.
            key={frame.data.iframeSrc}
            {...frame.data}
            fit="fill"
            tokenErrorFallback={
              <Stack p="md">
                <Alert color="red" variant="light">
                  The preview couldn’t sign in to your app. Reload, or ask the assistant to restart
                  the preview.
                </Alert>
                {restart && <RestartPreview restart={restart} reason={PREVIEW_NOT_LOADING} />}
              </Stack>
            }
          />
        )}
      </div>
    </div>
  );
}
