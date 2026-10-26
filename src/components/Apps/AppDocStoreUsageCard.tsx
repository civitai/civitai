import { Card, Group, Progress, Stack, Text, Title } from '@mantine/core';

import type { MyDocStoreUsage } from '~/server/services/apps/doc-store-owner-usage.service';
import { formatBytes, numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

/**
 * The owner's document-storage card on the `/apps/build` workbench: for each app the viewer
 * owns, its production document-store usage against the per-app limits. Client of
 * `appListings.getMyDocStoreUsage`.
 *
 * Renders nothing while loading, when storage is disabled, or when the viewer owns no
 * on-platform app, so a figure on screen is always one the store reported. An app whose read
 * failed says "Usage unavailable" rather than showing zero.
 */

function percent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

function barColor(pct: number): string {
  if (pct >= 90) return 'red';
  if (pct >= 75) return 'yellow';
  return 'blue';
}

export function AppDocStoreUsageCardView({ data }: { data?: MyDocStoreUsage }) {
  if (!data || data.status !== 'ok' || data.apps.length === 0) return null;
  const { limits } = data;

  return (
    <Card withBorder radius="md" padding="md" data-testid="apps-docstore-usage">
      <Stack gap="sm">
        <Stack gap={2}>
          <Title order={4}>Document storage</Title>
          <Text size="xs" c="dimmed">
            Published data each app keeps in the document store, against its per-app limit.
          </Text>
        </Stack>
        {data.apps.map((app) => {
          const bytesPct = app.usage ? percent(app.usage.bytes, limits.appBytes) : 0;
          return (
            <Stack
              key={app.appBlockId}
              gap={4}
              data-testid={`apps-docstore-usage-${app.appBlockId}`}
            >
              <Text size="sm" fw={600}>
                {app.name}
              </Text>
              {app.usage ? (
                <>
                  <Group justify="space-between" gap="xs">
                    <Text size="xs" c="dimmed">
                      {app.usage.bytes > 0 ? formatBytes(app.usage.bytes) : '0 B'} of{' '}
                      {formatBytes(limits.appBytes)}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {numberWithCommas(app.usage.docs)} of {numberWithCommas(limits.appDocs)}{' '}
                      documents
                    </Text>
                  </Group>
                  <Progress.Root size="sm">
                    <Progress.Section
                      value={bytesPct}
                      color={barColor(bytesPct)}
                      aria-label={`${app.name} storage used`}
                      data-testid={`apps-docstore-usage-bytes-${app.appBlockId}`}
                    />
                  </Progress.Root>
                </>
              ) : (
                <Text size="xs" c="dimmed">
                  Usage unavailable right now.
                </Text>
              )}
            </Stack>
          );
        })}
      </Stack>
    </Card>
  );
}

export function AppDocStoreUsageCard() {
  const query = trpc.appListings.getMyDocStoreUsage.useQuery(undefined, { retry: false });
  return <AppDocStoreUsageCardView data={query.data} />;
}
