import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Center, Loader, Stack, Text } from '@mantine/core';
import { trpc } from '~/utils/trpc';

export const DEV_TUNNEL_DNS_POLL_MS = 2_500;
/** The record is normally published within about a minute. */
export const DEV_TUNNEL_DNS_WAIT_MS = 3 * 60_000;

export interface DevTunnelDnsGateProps {
  blockId: string;
  /**
   * The wait is over: the host resolves, or the tunnel is gone. The owner re-fetches its frame,
   * which is what replaces this gate; it may be called again while the gate stays mounted.
   */
  onSettled: () => void;
  pollMs?: number;
  waitMs?: number;
}

/**
 * Stands in for a dev-tunnel frame whose host is not resolvable yet. It never renders the app:
 * the server withholds the entry URL until the host's DNS record is published.
 */
export function DevTunnelDnsGate({
  blockId,
  onSettled,
  pollMs = DEV_TUNNEL_DNS_POLL_MS,
  waitMs = DEV_TUNNEL_DNS_WAIT_MS,
}: DevTunnelDnsGateProps) {
  const [timedOut, setTimedOut] = useState(false);
  const { data, dataUpdatedAt } = trpc.blocks.devTunnelDnsReady.useQuery(
    { blockId },
    {
      enabled: !timedOut,
      refetchInterval: timedOut ? false : pollMs,
      // The wait is usually spent in another tab.
      refetchIntervalInBackground: true,
      refetchOnWindowFocus: false,
      retry: false,
      staleTime: 0,
      gcTime: 0,
    }
  );

  useEffect(() => {
    if (timedOut) return;
    const timer = setTimeout(() => setTimedOut(true), waitMs);
    return () => clearTimeout(timer);
  }, [timedOut, waitMs]);

  const settled = !!data && (!data.active || data.ready);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  useEffect(() => {
    if (settled) onSettledRef.current();
  }, [settled, dataUpdatedAt]);

  if (timedOut)
    return (
      <Stack p="md" gap="sm" align="flex-start">
        <Alert color="yellow" variant="light">
          The preview is taking longer than usual to come online.
        </Alert>
        <Button size="compact-sm" variant="light" onClick={() => setTimedOut(false)}>
          Keep waiting
        </Button>
      </Stack>
    );

  return (
    <Center className="h-full p-6">
      <Stack align="center" gap="xs">
        <Loader size="sm" />
        <Text size="sm">Preparing the preview…</Text>
        <Text size="xs" c="dimmed" ta="center">
          A new preview takes about a minute to come online.
        </Text>
      </Stack>
    </Center>
  );
}
