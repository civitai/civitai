import { Alert, Button, Group, Loader, Skeleton, Stack, Text } from '@mantine/core';
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
  /**
   * In-progress feedback for the host's BOUNDED AUTO-RETRY. When set, the host
   * has already scheduled another automatic attempt: the fallback still shows the
   * REAL terminal message (the error is never masked or delayed) and adds a line
   * saying a retry is under way and which attempt it is — so a user who then
   * presses the button doesn't experience "the button does nothing".
   *
   * `attempt`/`maxAttempts` are 1-based. `animate:false` (driven by
   * `prefers-reduced-motion: reduce` upstream) suppresses the spinner; the copy
   * alone then carries the state.
   */
  autoRetry?: { attempt: number; maxAttempts: number; animate: boolean };
  /**
   * Number of AUTOMATIC attempts already spent. Renders an honest "we already
   * tried N times" note — only when > 0, so a surface with no auto-retry wired
   * never claims a retry that didn't happen.
   */
  autoRetriesSpent?: number;
  /**
   * Make the manual Retry affordance UNMISSABLE. Set by PageBlockHost once the
   * host has SETTLED (no further automatic attempt is coming) — that is the
   * moment the user must notice the button, which is precisely what was reported
   * as missed. Renders a filled, full-width, medium button instead of the small
   * subdued default. Default `false` keeps the model-slot IframeHost and every
   * other existing caller byte-identical.
   */
  prominentRetry?: boolean;
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
  autoRetry,
  autoRetriesSpent = 0,
  prominentRetry = false,
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
        {autoRetry ? (
          // Live region: the attempt count changes while the user is already
          // looking at a static error, so announce it instead of mutating the
          // text silently.
          <Group
            gap="xs"
            data-block-fallback-autoretry="true"
            // Observable animation state — `false` under prefers-reduced-motion.
            data-block-fallback-autoretry-animate={autoRetry.animate ? 'true' : 'false'}
            role="status"
            aria-live="polite"
          >
            {/* Reduced motion: no spinner at all — the copy carries the state. */}
            {autoRetry.animate && <Loader size="xs" aria-hidden />}
            <Text size="sm" c="dimmed">
              {`Retrying automatically… (attempt ${autoRetry.attempt} of ${autoRetry.maxAttempts})`}
            </Text>
          </Group>
        ) : autoRetriesSpent > 0 ? (
          <Text size="sm" c="dimmed" data-block-fallback-autoretry-spent={String(autoRetriesSpent)}>
            {autoRetriesSpent === 1
              ? 'We already retried once automatically.'
              : `We already retried ${autoRetriesSpent} times automatically.`}
          </Text>
        ) : null}
        {onRetry && (
          <Button
            // Once automatic recovery has settled, the button IS the path
            // forward — so it stops being a small subdued affordance.
            variant={prominentRetry ? 'filled' : 'light'}
            color={copy.color}
            size={prominentRetry ? 'md' : 'xs'}
            fullWidth={prominentRetry}
            leftSection={<IconRefresh size={prominentRetry ? 18 : 16} />}
            onClick={onRetry}
            data-block-fallback-retry="true"
            data-block-fallback-retry-prominent={prominentRetry ? 'true' : 'false'}
          >
            {/* The accessible name stays "Retry" in BOTH states: existing
                callers/tests target one stable name, and a user reading the
                button never has to re-learn it mid-failure. */}
            Retry
          </Button>
        )}
      </Stack>
    </Alert>
  );
}
