import { Badge, Button, Center, Group, Loader, Paper, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import type { CSSProperties } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { NsfwLevel } from '~/server/common/enums';
import { Flags } from '~/shared/utils/flags';

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
  browsingLevel?: number;
  // When false, the countdown pauses and the UI shows a "retrying now" state.
  // Parent sets this to !isFetching so we don't fire the next retry until the
  // current request has actually resolved (prevents concurrent duplicate calls
  // when the backend is slow).
  countdownActive?: boolean;
  // True when zero pages have loaded yet — copy changes to "loading images"
  // instead of "loading more images".
  isInitialLoad?: boolean;
};

// Phrase pools gated by feed browsing level flags. "minLevel" is the NsfwLevel
// flag that must be present in the feed's browsingLevel for this phrase to be
// eligible. PG is always included; R adds edgier jokes; X/XXX unlock innuendo.
// Green-site feeds force a PG-only browsingLevel, so those users will never see
// anything above the PG pool regardless of their personal settings.
const PHRASES: Array<{ text: string; minLevel: number }> = [
  { text: 'Waking up the hamsters in the server room…', minLevel: NsfwLevel.PG },
  { text: 'Polishing the pixels…', minLevel: NsfwLevel.PG },
  { text: 'Convincing the GPUs to cooperate…', minLevel: NsfwLevel.PG },
  { text: 'Arguing with the database…', minLevel: NsfwLevel.PG },
  { text: 'Bribing the load balancer with cookies…', minLevel: NsfwLevel.PG },
  { text: 'Teaching robots to appreciate art…', minLevel: NsfwLevel.PG },
  { text: 'Consulting the all-knowing cache…', minLevel: NsfwLevel.PG },
  { text: 'Petting the algorithm…', minLevel: NsfwLevel.PG },
  { text: 'Rerouting through the backup dimension…', minLevel: NsfwLevel.PG },
  { text: 'Asking Meilisearch nicely…', minLevel: NsfwLevel.PG },
  { text: 'Herding electrons…', minLevel: NsfwLevel.PG },
  { text: 'Untangling the tensors…', minLevel: NsfwLevel.PG },
  { text: 'Rebooting the vibes…', minLevel: NsfwLevel.PG },
  { text: 'Counting the bits, twice…', minLevel: NsfwLevel.PG },
  { text: 'Feeding snacks to the index…', minLevel: NsfwLevel.PG },

  { text: 'Flirting with the search index…', minLevel: NsfwLevel.R },
  { text: 'Whispering sweet nothings to the server…', minLevel: NsfwLevel.R },
  { text: 'Buying the database a drink…', minLevel: NsfwLevel.R },
  { text: 'Lighting candles for a faster response…', minLevel: NsfwLevel.R },
  { text: 'The servers are blushing, one moment…', minLevel: NsfwLevel.R },

  { text: 'The GPUs have been at it all night…', minLevel: NsfwLevel.X },
  { text: 'Meilisearch stripped its cache for you…', minLevel: NsfwLevel.X },
  { text: 'The index is lubed up and loading…', minLevel: NsfwLevel.X },
  { text: 'Servers are panting, give them a second…', minLevel: NsfwLevel.X },
  { text: 'Undressing the query plan, one clause at a time…', minLevel: NsfwLevel.X },
  { text: 'The load balancer finished first, waiting on the rest…', minLevel: NsfwLevel.X },
  { text: 'Our servers are working hard, so hard…', minLevel: NsfwLevel.X },
  { text: 'Watching Postgres get tied up in a transaction…', minLevel: NsfwLevel.X },

  { text: 'Meilisearch is between requests — if you know what we mean…', minLevel: NsfwLevel.XXX },
  {
    text: 'Three-way between Redis, Postgres, and Meilisearch is running long…',
    minLevel: NsfwLevel.XXX,
  },
  { text: 'The load balancer pulled out early, Postgres is recovering…', minLevel: NsfwLevel.XXX },
  { text: 'The database is safewording, easing off the load…', minLevel: NsfwLevel.XXX },
  { text: 'Meilisearch is edging — almost there…', minLevel: NsfwLevel.XXX },
  { text: 'The cache is cumming right up…', minLevel: NsfwLevel.XXX },
  { text: 'Our servers need aftercare, bear with us…', minLevel: NsfwLevel.XXX },
  { text: 'The index is balls-deep in documents right now…', minLevel: NsfwLevel.XXX },
];

function pickPhrases(browsingLevel: number) {
  // Always include PG. Layer in higher tiers only when the feed's flag is set.
  return PHRASES.filter((p) => {
    if (p.minLevel === NsfwLevel.PG) return true;
    return Flags.hasFlag(browsingLevel, p.minLevel);
  });
}

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function SearchRetryBanner({
  delayMs,
  attempt,
  maxAttempts,
  onRetry,
  onGiveUp,
  debugMode = false,
  browsingLevel = NsfwLevel.PG,
  countdownActive = true,
  isInitialLoad = false,
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

  // Freeze a shuffled phrase pool per mount so a single banner session gets a
  // stable sequence; regenerating every render would flicker.
  const phrasePool = useMemo(() => shuffle(pickPhrases(browsingLevel)), [browsingLevel]);
  const [phraseIndex, setPhraseIndex] = useState(0);

  useEffect(() => {
    if (exhausted || phrasePool.length <= 1) return;
    const id = setInterval(() => {
      setPhraseIndex((i) => (i + 1) % phrasePool.length);
    }, 2500);
    return () => clearInterval(id);
  }, [exhausted, phrasePool.length]);

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
              Our search service is having trouble. Try again in a moment.
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
  const phrase = phrasePool[phraseIndex]?.text ?? 'Working on it…';
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
              {effectiveCountdownActive
                ? `Having trouble loading ${noun}`
                : 'Retrying now — hang tight'}
            </Text>
            {debugMode && (
              <Badge color="yellow" variant="filled" size="sm">
                DEBUG
              </Badge>
            )}
          </Group>
          <Text size="sm" ta="center" fs="italic" c="dimmed">
            {phrase}
          </Text>
          <Text size="xs" c="dimmed">
            {effectiveCountdownActive
              ? `Retrying in ${seconds}s · Attempt ${attempt} of ${maxAttempts}`
              : `Attempt ${attempt} of ${maxAttempts}`}
          </Text>
        </Stack>
      </Paper>
    </Center>
  );
}
