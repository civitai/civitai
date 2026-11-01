import { Badge, Button, Center, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';

// Minimum time to show the "retrying now" state before flipping back to the
// countdown. Real failures can resolve in milliseconds; without a floor the
// title text flashes and looks broken.
const MIN_RETRYING_DISPLAY_MS = 1000;

// Matches the crypto deposit "outer card" look — light/dark-aware surface with
// a soft shadow. Kept inline to avoid importing from a Buzz-specific constants
// module into an unrelated feature.
const cardStyle: CSSProperties = {
  background: 'light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))',
  boxShadow: 'light-dark(0 1px 3px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.5))',
};

type SearchRetryBannerProps = {
  delayMs: number;
  attempt: number;
  maxAttempts: number;
  onRetry: () => void;
  onGiveUp?: () => void;
  debugMode?: boolean;
  // When false, the countdown pauses and the UI shows a "retrying now" state.
  // Parent sets this to !isFetching so we don't fire the next retry until the
  // current request has actually resolved (prevents concurrent duplicate calls
  // when the backend is slow).
  countdownActive?: boolean;
  // True when zero pages have loaded yet — copy changes to "loading images"
  // instead of "loading more images".
  isInitialLoad?: boolean;
  // True when the current request has exceeded the slow threshold: swaps to the
  // slow copy and reframes the countdown as time until abort instead of time
  // until retry.
  slow?: boolean;
};

export function SearchRetryBanner({
  delayMs,
  attempt,
  maxAttempts,
  onRetry,
  onGiveUp,
  debugMode = false,
  countdownActive = true,
  isInitialLoad = false,
  slow = false,
}: SearchRetryBannerProps) {
  const noun = isInitialLoad ? 'images' : 'more images';
  const exhausted = attempt > maxAttempts;
  const [remainingMs, setRemainingMs] = useState(delayMs);
  const firedRef = useRef(false);

  // Hold the "retrying now" state on-screen for at least MIN_RETRYING_DISPLAY_MS
  // even if the real request resolves immediately, so the title doesn't flash.
  const [effectiveCountdownActive, setEffectiveCountdownActive] = useState(countdownActive);
  const retryingStartRef = useRef<number | null>(null);
  useEffect(() => {
    if (!countdownActive) {
      retryingStartRef.current = Date.now();
      setEffectiveCountdownActive(false);
      return;
    }
    const startedAt = retryingStartRef.current;
    const elapsed = startedAt ? Date.now() - startedAt : MIN_RETRYING_DISPLAY_MS;
    if (elapsed >= MIN_RETRYING_DISPLAY_MS) {
      setEffectiveCountdownActive(true);
      return;
    }
    const t = setTimeout(
      () => setEffectiveCountdownActive(true),
      MIN_RETRYING_DISPLAY_MS - elapsed
    );
    return () => clearTimeout(t);
  }, [countdownActive]);

  // Reset countdown whenever a new retry cycle starts. Skipped while a request
  // is in flight (countdownActive=false) so we don't pile up concurrent retries
  // when the backend is slow to fail. Uses the debounced "effective" flag so
  // the brief "retrying now" state is guaranteed a minimum on-screen time.
  useEffect(() => {
    if (exhausted || !effectiveCountdownActive) return;
    firedRef.current = false;
    setRemainingMs(delayMs);
    const startedAt = Date.now();
    const interval = setInterval(() => {
      const remaining = Math.max(0, delayMs - (Date.now() - startedAt));
      setRemainingMs(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
        if (!firedRef.current) {
          firedRef.current = true;
          onRetry();
        }
      }
    }, 200);
    return () => clearInterval(interval);
  }, [delayMs, attempt, exhausted, onRetry, effectiveCountdownActive]);

  useEffect(() => {
    if (exhausted) onGiveUp?.();
  }, [exhausted, onGiveUp]);

  if (exhausted) {
    return (
      <Center py="md">
        <Paper p="lg" radius="md" withBorder maw={420} w="100%" style={cardStyle}>
          <Stack gap="sm" align="center">
            <Group gap={6}>
              <IconAlertTriangle size={20} stroke={1.5} className="text-orange-5" />
              <Text size="sm" fw={600}>
                Unable to load {noun} right now
              </Text>
              {debugMode && (
                <Badge color="yellow" variant="filled" size="sm">
                  DEBUG
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed" ta="center">
              Something went wrong on our end. Try again in a moment.
            </Text>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconRefresh size={14} />}
              onClick={() => {
                firedRef.current = true;
                onRetry();
              }}
            >
              Try again
            </Button>
          </Stack>
        </Paper>
      </Center>
    );
  }

  const seconds = Math.ceil(remainingMs / 1000);
  return (
    <Center py="md">
      <Paper
        p="lg"
        px={60}
        radius="md"
        withBorder
        maw={420}
        w="100%"
        pos="relative"
        style={cardStyle}
      >
        {/* Absolute-position spinner so title-text length changes don't jump the spinner. */}
        <Loader
          size="md"
          pos="absolute"
          left={16}
          top="50%"
          style={{ transform: 'translateY(-50%)' }}
        />
        <Stack gap="sm" align="center">
          <Group gap={8}>
            <Text size="sm" fw={600}>
              {slow
                ? `${isInitialLoad ? 'Images' : 'More images'} are taking longer than usual`
                : effectiveCountdownActive
                ? `Couldn't load ${noun} yet`
                : 'Retrying now — hang tight'}
            </Text>
            {debugMode && (
              <Badge color="yellow" variant="filled" size="sm">
                DEBUG
              </Badge>
            )}
          </Group>
          <Text size="sm" ta="center" c="dimmed">
            We&apos;ll keep trying automatically.
          </Text>
          <Text size="xs" c="dimmed">
            {slow || effectiveCountdownActive
              ? `Retrying in ${seconds}s · Attempt ${attempt} of ${maxAttempts}`
              : `Attempt ${attempt} of ${maxAttempts}`}
          </Text>
        </Stack>
      </Paper>
    </Center>
  );
}
