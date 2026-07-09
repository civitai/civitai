import { Alert, Button, Skeleton, Stack, Text } from '@mantine/core';
import { IconRefresh } from '@tabler/icons-react';

type FallbackReason = 'loading' | 'token_error' | 'timeout' | 'fatal_block_error';

interface BlockFallbackProps {
  reason: FallbackReason;
  blockName?: string;
  minHeight?: number;
  /**
   * Terminal-state recovery. When supplied (PageBlockHost passes it for the
   * full-page `/apps/run/<slug>` surface), the fallback renders a "Retry"
   * button that re-attempts the load (remount the iframe + re-arm the init
   * handshake). When omitted (the model-slot IframeHost, where a failed column
   * can just collapse), no button is shown — backward-compatible. Never shown
   * for the non-terminal `loading` reason.
   */
  onRetry?: () => void;
}

const DEFAULT_MIN_HEIGHT = 200;

/**
 * Human-readable copy for each terminal failure reason. The page-host
 * previously fell to a terse, dev-flavoured one-liner ("Block took too long to
 * load") with no recovery, so a transient timeout read like a dead loading
 * state. Each terminal reason now gets a clear title + a short, actionable
 * hint. Copy uses "app" (platform-wide "Apps" rename) rather than "block".
 */
const REASON_COPY: Record<
  Exclude<FallbackReason, 'loading'>,
  { color: string; title: string; hint: string }
> = {
  timeout: {
    color: 'gray',
    title: "This app didn't load in time",
    hint: 'It may be a temporary network or server hiccup. Try again.',
  },
  token_error: {
    color: 'yellow',
    title: "Couldn't authenticate this app",
    hint: "We couldn't authorize this app for you. Try again, or reload the page.",
  },
  fatal_block_error: {
    color: 'red',
    title: 'This app failed to load',
    hint: 'The app reported an error while starting up. Try again.',
  },
};

export function BlockFallback({
  reason,
  blockName,
  minHeight = DEFAULT_MIN_HEIGHT,
  onRetry,
}: BlockFallbackProps) {
  if (reason === 'loading') {
    return <Skeleton h={minHeight} radius="md" data-block-fallback="loading" />;
  }

  const copy = REASON_COPY[reason];
  // Surface the (sanitized upstream) app name in the fatal case so the user
  // knows which app failed; the other reasons read fine without it.
  const title =
    reason === 'fatal_block_error' && blockName ? `${blockName} failed to load` : copy.title;

  return (
    <Alert color={copy.color} title={title} data-block-fallback={reason}>
      <Stack gap="sm">
        <Text size="sm">{copy.hint}</Text>
        {onRetry && (
          <Button
            variant="light"
            color={copy.color}
            size="xs"
            leftSection={<IconRefresh size={16} />}
            onClick={onRetry}
            data-block-fallback-retry="true"
          >
            Retry
          </Button>
        )}
      </Stack>
    </Alert>
  );
}
