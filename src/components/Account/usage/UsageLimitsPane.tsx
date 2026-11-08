import { Alert, Button, Code, Loader, Paper, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { UsageLimitCard } from '~/components/Account/usage/UsageLimitCard';
import { formatWhen, type UsageLimitRow } from '~/components/Account/usage/usage-limit-view';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { capitalize } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const STALE_MS = 30_000;

/** Re-renders every 30 s so "+1 at …" turns into "available now" without a refetch. */
function useNow(intervalMs = STALE_MS) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function UsageLimitsPane() {
  const now = useNow();
  const limits = trpc.user.getUsageLimits.useQuery(undefined, { staleTime: STALE_MS });
  const active = trpc.user.getActiveLimits.useQuery(undefined, { staleTime: STALE_MS });

  const areas = useMemo(() => {
    const byArea = new Map<string, UsageLimitRow[]>();
    for (const row of limits.data?.limits ?? []) {
      byArea.set(row.area, [...(byArea.get(row.area) ?? []), row]);
    }
    return [...byArea];
  }, [limits.data]);

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        What you can do per day or hour on your plan, how much you&apos;ve used, and when it frees
        up. Times are in your time zone.
      </Text>
      <UsagePlanBanner />
      {active.data?.map(({ area, retryAt }) => (
        <Alert key={area} color="orange" icon={<IconAlertTriangle size={18} />} p="sm">
          <Text size="sm">
            <b>You&apos;ve hit a temporary limit on {area}.</b> You can try again at{' '}
            {formatWhen(Date.parse(retryAt), now)}.
          </Text>
        </Alert>
      ))}
      {limits.isLoading ? (
        <Loader size="sm" className="mx-auto" />
      ) : limits.isError ? (
        <Text size="sm" c="red">
          Couldn&apos;t load your usage limits. Try again in a moment.
        </Text>
      ) : areas.length === 0 ? (
        <Text size="sm" c="dimmed">
          No limits apply to you right now.
        </Text>
      ) : (
        areas.map(([area, rows]) => <UsageLimitCard key={area} area={area} rows={rows} now={now} />)
      )}
      <Paper withBorder radius="md" p="sm" className="bg-gray-0 dark:bg-dark-7">
        <Text size="xs" c="dimmed">
          For scripts: <Code>GET /api/v1/me/limits</Code> returns this as JSON. Every limit error is
          HTTP 429 with a <Code>Retry-After</Code> header.
        </Text>
      </Paper>
    </Stack>
  );
}

function UsagePlanBanner() {
  const currentUser = useCurrentUser();
  if (!currentUser) return null;
  const tier = currentUser.tier && currentUser.tier !== 'free' ? currentUser.tier : undefined;
  const score = currentUser.meta?.scores?.total;
  return (
    <Paper
      radius="md"
      p="sm"
      className="flex flex-col items-start gap-3 bg-blue-0 sm:flex-row sm:items-center sm:justify-between dark:bg-blue-9/20"
    >
      <div>
        <Text size="sm">
          Your plan:{' '}
          <Text span fw={700} c="blue">
            {tier ? `${capitalize(tier)} member` : 'Free'}
          </Text>
          {score !== undefined && <> · Creator Score {Math.round(score).toLocaleString('en-US')}</>}
        </Text>
        <Text size="xs" c="dimmed">
          Posting and generation limits rise with membership and Creator Score.
        </Text>
      </div>
      <Button component={Link} href="/pricing" size="xs">
        Compare plans
      </Button>
    </Paper>
  );
}
