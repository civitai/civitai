import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Center, Loader, Stack, Text } from '@mantine/core';
import { trpc } from '~/utils/trpc';

export const DEV_TUNNEL_DNS_POLL_MS = 2_500;
/** The record is normally published within about a minute. */
export const DEV_TUNNEL_DNS_WAIT_MS = 3 * 60_000;

export interface DevTunnelDnsGateProps {
  blockId: string;
  /**
   * The host resolves, or the tunnel is gone. Polling pauses until the returned promise settles;
   * if the gate is still mounted one poll interval later, it polls again and may call this again.
   */
  onSettled: () => unknown;
  pollMs?: number;
  waitMs?: number;
}

/** Stands in for a dev-tunnel frame whose host is not resolvable yet. */
export function DevTunnelDnsGate({
  blockId,
  onSettled,
  pollMs = DEV_TUNNEL_DNS_POLL_MS,
  waitMs = DEV_TUNNEL_DNS_WAIT_MS,
}: DevTunnelDnsGateProps) {
  const [timedOut, setTimedOut] = useState(false);
  const [settling, setSettling] = useState(false);
  const polling = !timedOut && !settling;
  const { data, dataUpdatedAt } = trpc.blocks.devTunnelDnsReady.useQuery(
    { blockId },
    {
      enabled: polling,
      refetchInterval: polling ? pollMs : false,
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
  const pollMsRef = useRef(pollMs);
  pollMsRef.current = pollMs;
  // Keyed on the poll result, not on `settling`: one call per answer, never two in flight.
  useEffect(() => {
    if (!settled) return;
    let mounted = true;
    let resume: ReturnType<typeof setTimeout> | undefined;
    setSettling(true);
    void Promise.resolve()
      .then(() => onSettledRef.current())
      .catch(() => undefined)
      .finally(() => {
        // Still here, so the owner was not ready after all: wait a full interval, not zero.
        if (mounted) resume = setTimeout(() => setSettling(false), pollMsRef.current);
      });
    return () => {
      mounted = false;
      clearTimeout(resume);
      // Otherwise a pause interrupted by a new answer or a new key would never end.
      setSettling(false);
    };
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
