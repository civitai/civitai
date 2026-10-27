import { useEffect, useState } from 'react';
import { Alert, Button, Center, Group, Loader, Stack, Text } from '@mantine/core';
import { IconPlayerPlay, IconRefresh } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { DevTunnelBlockHost } from '~/components/AppBlocks/DevTunnelBlockHost';
import { DevTunnelDnsGate } from '~/components/AppBlocks/DevTunnelDnsGate';
import { fetchPreviewFrame, PreviewGoneError } from '~/components/Apps/AppAssistant/previewFrame';
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

/**
 * How often a shown preview on the server runner is checked for still being live (and again when
 * the tab comes back into view): civitai reaps an idle tunnel, and a frame already loaded never
 * notices its host is gone.
 */
export const PREVIEW_LIVE_CHECK_MS = 60_000;

/** What the pane says when no preview of the open app is live (after a reload, say). */
export const NO_LIVE_PREVIEW = 'The live preview isn’t running.';
/** …and when the app's frame would not load. */
export const PREVIEW_NOT_LOADING = 'The preview isn’t loading.';
/** …and beside its caption while a preview is shown: what the app saves there does not last. */
export const PREVIEW_DATA_RESETS = 'Data saved in the preview resets when it reloads.';

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
  liveCheckMs = PREVIEW_LIVE_CHECK_MS,
}: {
  canPreview: boolean;
  session: PreviewSession | null;
  /** On the server runner: the pane offers it when no preview is live, or the app will not load. */
  restart?: PreviewRestart;
  /** How often a shown preview is checked for still being live (`PREVIEW_LIVE_CHECK_MS`). */
  liveCheckMs?: number;
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
  // On the server runner, while the frame is up: whether civitai still has a live tunnel for it.
  // Only its answer that there is none (`PreviewGoneError`) counts; any other failure leaves the
  // preview shown. Each preview (`view`) is checked afresh, so an old answer never ends a new one.
  const live = useQuery({
    queryKey: [
      'app-assistant',
      'preview-live',
      session?.blockId,
      session?.sessionId,
      session?.view,
    ],
    queryFn: async () => {
      try {
        await fetchPreviewFrame((session as PreviewSession).blockId);
        return true;
      } catch (error) {
        if (error instanceof PreviewGoneError) return false;
        throw error;
      }
    },
    enabled: !!session && !!restart && !!frame.data,
    // The frame's own fetch just said it is live.
    initialData: true,
    staleTime: liveCheckMs,
    refetchInterval: liveCheckMs,
    refetchOnWindowFocus: true,
    gcTime: 0,
    retry: false,
  });
  const gone = !!restart && live.data === false;

  if (!canPreview)
    return (
      <EmptyState>
        Live preview isn’t enabled for your account yet. The assistant can still build and test your
        app.
      </EmptyState>
    );
  if ((!session || gone) && restart)
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
        <Stack gap={0} className="min-w-0">
          <Text size="xs" c="dimmed" truncate>
            New previews can take a minute to appear.
          </Text>
          {/* The SDK keeps a preview's `app.storage` in memory in this tab (`local-preview`). */}
          <Text size="xs" c="dimmed" truncate>
            {PREVIEW_DATA_RESETS}
          </Text>
        </Stack>
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
            // The app reloaded itself (Vite live reload): the Reload button's own path. Not
            // `cancelRefetch`, so reports arriving mid-fetch join it rather than restart it.
            onGuestReloaded={() => void frame.refetch({ cancelRefetch: false })}
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
