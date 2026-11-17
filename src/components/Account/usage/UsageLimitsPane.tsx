import { Alert, Button, Code, Loader, Paper, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useMemo, type ReactNode } from 'react';
import { AppStorageCard } from '~/components/Account/AppStorageCard';
import { UsageLimitCard } from '~/components/Account/usage/UsageLimitCard';
import { formatWhen, type UsageLimitRow } from '~/components/Account/usage/usage-limit-view';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useNowTick } from '~/components/Apps/reviewRelativeTime';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { capitalize } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const STALE_MS = 30_000;

/** Re-renders every 30 s so "+1 at …" turns into "available now" without a refetch. */
export function UsageLimitsPane() {
  const now = useNowTick(STALE_MS).getTime();
  const currentUser = useCurrentUser();
  const limits = trpc.user.getUsageLimits.useQuery(undefined, { staleTime: STALE_MS });
  const active = trpc.user.getActiveLimits.useQuery(undefined, { staleTime: STALE_MS });
  const appBuzz = trpc.user.getAppBuzzUsage.useQuery(undefined, {
    staleTime: STALE_MS,
    retry: false,
  });

  return (
    <UsageLimitsView
      now={now}
      plan={
        currentUser
          ? { tier: currentUser.tier, creatorScore: currentUser.meta?.scores?.total }
          : undefined
      }
      limits={limits.data?.limits}
      status={limits.isLoading ? 'loading' : limits.isError ? 'error' : 'ready'}
      active={active.data ?? []}
      appBuzz={appBuzz.data ?? undefined}
      appStorage={<AppStorageCard flat />}
    />
  );
}

export type UsageLimitsViewProps = {
  now: number;
  timeZone?: string;
  plan?: { tier?: string; creatorScore?: number };
  limits?: UsageLimitRow[];
  status: 'loading' | 'error' | 'ready';
  active: { area: string; retryAt: string }[];
  /** Buzz spent through apps today; absent where apps are off or it failed to load. */
  appBuzz?: UsageLimitRow;
  /** The per-app storage card, which loads and gates itself. */
  appStorage?: ReactNode;
};

export function UsageLimitsView({
  now,
  timeZone,
  plan,
  limits,
  status,
  active,
  appBuzz,
  appStorage,
}: UsageLimitsViewProps) {
  const areas = useMemo(() => {
    const byArea = new Map<string, UsageLimitRow[]>();
    for (const row of limits ?? []) byArea.set(row.area, [...(byArea.get(row.area) ?? []), row]);
    return [...byArea];
  }, [limits]);

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        What you can do per day or hour on your plan, how much you&apos;ve used, and when it frees
        up. Times are in your time zone.
      </Text>
      {plan && <UsagePlanBanner {...plan} />}
      {active.map(({ area, retryAt }) => (
        <Alert key={area} color="orange" icon={<IconAlertTriangle size={18} />} p="sm">
          <Text size="sm">
            <b>You&apos;ve hit a temporary limit on {area}.</b> You can try again at{' '}
            {formatWhen(Date.parse(retryAt), now, timeZone)}.
          </Text>
        </Alert>
      ))}
      {status === 'loading' ? (
        <Loader size="sm" className="mx-auto" />
      ) : status === 'error' ? (
        <Text size="sm" c="red">
          Couldn&apos;t load your usage limits. Try again in a moment.
        </Text>
      ) : areas.length === 0 ? (
        <Text size="sm" c="dimmed">
          No limits apply to you right now.
        </Text>
      ) : (
        areas.map(([area, rows]) => (
          <UsageLimitCard key={area} area={area} rows={rows} now={now} timeZone={timeZone} />
        ))
      )}
      {appBuzz && <UsageLimitCard area="apps" rows={[appBuzz]} now={now} timeZone={timeZone} />}
      {appStorage}
      <Paper withBorder radius="md" p="sm" className="bg-gray-0 dark:bg-dark-7">
        <Text size="xs" c="dimmed">
          For scripts: <Code>GET /api/v1/me/limits</Code> returns this as JSON. A limit error is
          HTTP 429; a single call refused by a limit that frees up also gets a{' '}
          <Code>Retry-After</Code> header.
        </Text>
      </Paper>
    </Stack>
  );
}

function UsagePlanBanner({ tier, creatorScore }: { tier?: string; creatorScore?: number }) {
  const paid = tier && tier !== 'free' ? tier : undefined;
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
            {paid ? `${capitalize(paid)} member` : 'Free'}
          </Text>
          {creatorScore !== undefined && (
            <> · Creator Score {Math.round(creatorScore).toLocaleString('en-US')}</>
          )}
        </Text>
        <Text size="xs" c="dimmed">
          Posting and comment limits rise with Creator Score, and posting also with membership.
        </Text>
      </div>
      <Button component={Link} href="/pricing" size="xs">
        Compare plans
      </Button>
    </Paper>
  );
}
