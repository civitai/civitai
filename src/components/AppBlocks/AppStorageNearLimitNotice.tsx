import { useState } from 'react';
import { Anchor, Box, Button, Group, Text } from '@mantine/core';
import { IconDatabase, IconX } from '@tabler/icons-react';
import NextLink from 'next/link';
import type { MyAppStorageForApp } from '~/server/services/apps/doc-store-viewer-usage.service';
import { isNearStorageLimit, storageUsageRatio } from '~/shared/utils/app-storage-usage';
import { trpc } from '~/utils/trpc';

/**
 * The running app's "you are close to your storage allowance in this app" notice, drawn by the
 * page host OUTSIDE the iframe (an app cannot hide it), between the chrome and the app.
 *
 * ONE QUERY PER APP OPENED, NEVER ONE PER STORAGE CALL. The app's document-store calls go
 * straight from the iframe to the storage routes with its block token, so the host sees none of
 * them; this reads the viewer's usage once (`appStorage.getMineForApp`, two primary-key reads)
 * and keeps it for `STALE_MS`. A write that crosses the threshold mid-session shows on the next
 * open, not live. The threshold is `isNearStorageLimit`, shared with the account-settings card.
 *
 * Dismissal is per app and per mount, like the missing-permissions notice: the host is not
 * remounted between two `/apps/run/<slug>` pages, so a bare flag would hide the next app's.
 */
const STALE_MS = 5 * 60 * 1000;

export function AppStorageNearLimitNoticeView({
  data,
  appName,
  onDismiss,
}: {
  data?: MyAppStorageForApp;
  appName?: string;
  onDismiss: () => void;
}) {
  if (!data || data.status !== 'ok' || !isNearStorageLimit(data.usage, data.limits)) return null;
  const pct = Math.min(100, Math.floor(storageUsageRatio(data.usage, data.limits) * 100));
  return (
    <Box
      role="status"
      data-testid="app-storage-near-limit"
      px="md"
      py="xs"
      style={{
        borderBottom: '1px solid var(--mantine-color-default-border)',
        background: 'var(--mantine-color-body)',
      }}
    >
      <Group justify="space-between" wrap="nowrap" gap="sm" align="center">
        <Group gap="xs" wrap="nowrap" className="min-w-0">
          <IconDatabase size={16} className="shrink-0" color="var(--mantine-color-yellow-6)" />
          <Text size="sm" className="min-w-0">
            You&apos;ve used {pct}% of your storage in {appName ?? 'this app'}. When it&apos;s full,
            the app can&apos;t save more for you.{' '}
            {/* A new tab: following it must not unload the app the viewer is in the middle of. */}
            <Anchor
              component={NextLink}
              href="/user/account/security"
              target="_blank"
              rel="noopener"
              size="sm"
            >
              Manage app storage
            </Anchor>
          </Text>
        </Group>
        <Button
          size="compact-sm"
          variant="subtle"
          aria-label="Dismiss the storage notice"
          data-testid="app-storage-near-limit-dismiss"
          onClick={onDismiss}
        >
          <IconX size={16} />
        </Button>
      </Group>
    </Box>
  );
}

/** Mounted by the host only for a live run of a storage app with a signed-in viewer. */
export function AppStorageNearLimitNotice({
  appBlockId,
  appName,
}: {
  appBlockId: string;
  appName?: string;
}) {
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const dismissed = dismissedFor === appBlockId;
  const query = trpc.appStorage.getMineForApp.useQuery(
    { appBlockId },
    { enabled: !dismissed, staleTime: STALE_MS, retry: false }
  );
  if (dismissed) return null;
  return (
    <AppStorageNearLimitNoticeView
      data={query.data}
      appName={appName}
      onDismiss={() => setDismissedFor(appBlockId)}
    />
  );
}
