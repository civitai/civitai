import { useRef, useState } from 'react';
import { Badge, Button, Checkbox, Group, Paper, Progress, Stack, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconDatabase } from '@tabler/icons-react';
import { CardOrSection } from '~/components/Account/SettingsLayout';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type {
  MyAppStorage,
  MyAppStorageApp,
} from '~/server/services/apps/doc-store-viewer-usage.service';
import { isNearStorageLimit, storagePercent } from '~/shared/utils/app-storage-usage';
import type { ViewerStorageLimits } from '~/shared/utils/app-storage-usage';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { formatBytes, numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

/**
 * "App storage" in account settings: every app the viewer keeps data in (production only), how
 * much of their per-app allowance it uses, and an "Empty" action. Client of
 * `appStorage.listMine` / `appStorage.emptyMine`.
 *
 * Renders nothing while loading, when storage is disabled, or when the viewer holds no data in
 * any app, so a figure on screen is always one the store reported.
 *
 * Emptying deletes the viewer's PRIVATE data in that app. What they posted for other people to
 * see (shared documents they authored) is only deleted when they tick the second option in the
 * confirmation; counters they started and their votes on other people's posts always stay.
 */

function barColor(pct: number): string {
  if (pct >= 90) return 'red';
  if (pct >= 80) return 'yellow';
  return 'blue';
}

export function AppStorageRow({
  app,
  limits,
  onEmpty,
  emptying,
}: {
  app: MyAppStorageApp;
  limits: ViewerStorageLimits;
  onEmpty: (app: MyAppStorageApp) => void;
  emptying: boolean;
}) {
  const label = app.name ?? 'A removed app';
  const bytesPct = storagePercent(app.usage.bytes, limits.userBytes);
  const docsPct = storagePercent(app.usage.docs, limits.userDocs);
  const near = isNearStorageLimit(app.usage, limits);
  return (
    <Paper withBorder p="md" radius="md" data-testid={`app-storage-row-${app.appBlockId}`}>
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
            <Text fw={600} size="sm" lineClamp={1} title={label} style={{ minWidth: 0 }}>
              {label}
            </Text>
            {near && (
              <Badge size="sm" color="yellow" variant="light">
                Near limit
              </Badge>
            )}
          </Group>
          <Button
            size="compact-sm"
            variant="subtle"
            color="red"
            loading={emptying}
            onClick={() => onEmpty(app)}
          >
            Empty
          </Button>
        </Group>
        <Stack gap={4}>
          <Group justify="space-between" gap="xs">
            <Text size="xs" c="dimmed">
              {formatBytes(app.usage.bytes)} of {formatBytes(limits.userBytes)}
            </Text>
            <Text size="xs" c="dimmed">
              {numberWithCommas(app.usage.docs)} of {numberWithCommas(limits.userDocs)} items
            </Text>
          </Group>
          <Progress.Root size="sm">
            <Progress.Section
              value={Math.max(bytesPct, docsPct)}
              color={barColor(Math.max(bytesPct, docsPct))}
              aria-label={`${label} storage used`}
              data-testid={`app-storage-bar-${app.appBlockId}`}
            />
          </Progress.Root>
        </Stack>
      </Stack>
    </Paper>
  );
}

function EmptyConfirmBody({
  appName,
  onIncludeSharedChange,
}: {
  appName: string;
  onIncludeSharedChange: (value: boolean) => void;
}) {
  const [includeShared, setIncludeShared] = useState(false);
  return (
    <Stack gap="sm">
      <Text size="sm">
        This permanently deletes your private data in <strong>{appName}</strong>: settings, drafts
        and anything else only you can see. It cannot be undone.
      </Text>
      <Checkbox
        label="Also delete what I posted in this app for other people to see"
        description="Your posts there disappear for everyone, along with the votes on them. Counters you started, and your votes on other people's posts, stay."
        checked={includeShared}
        onChange={(e) => {
          setIncludeShared(e.currentTarget.checked);
          onIncludeSharedChange(e.currentTarget.checked);
        }}
      />
    </Stack>
  );
}

export function AppStorageCardView({
  data,
  onEmpty,
  emptyingId,
  flat,
}: {
  data?: MyAppStorage;
  onEmpty: (app: MyAppStorageApp) => void;
  emptyingId?: string | null;
  flat?: boolean;
}) {
  if (!data || data.status !== 'ok' || data.apps.length === 0) return null;
  if (data) return null; // STUB: tests-first commit
  return (
    <CardOrSection
      flat={flat}
      title="App storage"
      description="Data apps keep for you, against each app's allowance per person."
    >
      <Stack gap="sm" data-testid="app-storage-card">
        {!flat && (
          <Group gap="xs">
            <IconDatabase size={20} />
            <Text size="sm" c="dimmed">
              Data apps keep for you, against each app&apos;s allowance per person.
            </Text>
          </Group>
        )}
        {data.apps.map((app) => (
          <AppStorageRow
            key={app.appBlockId}
            app={app}
            limits={data.limits}
            onEmpty={onEmpty}
            emptying={emptyingId === app.appBlockId}
          />
        ))}
      </Stack>
    </CardOrSection>
  );
}

export function AppStorageCard({ flat }: { flat?: boolean } = {}) {
  const features = useFeatureFlags();
  const utils = trpc.useUtils();
  const enabled = !!features.appBlocks;
  const query = trpc.appStorage.listMine.useQuery(undefined, { enabled, retry: false });
  const includeSharedRef = useRef(false);
  const emptyMutation = trpc.appStorage.emptyMine.useMutation({
    onSuccess: (result, { appBlockId }) => {
      utils.appStorage.listMine.invalidate();
      utils.appStorage.getMineForApp.invalidate({ appBlockId });
      const removed = result.privateDocs + result.sharedDocs;
      showSuccessNotification({
        message:
          removed === 0
            ? 'There was nothing left to delete.'
            : `Deleted ${numberWithCommas(removed)} ${removed === 1 ? 'item' : 'items'}.`,
      });
    },
    onError: (error) => showErrorNotification({ error: new Error(error.message) }),
  });

  const handleEmpty = (app: MyAppStorageApp) => {
    const appName = app.name ?? 'this removed app';
    includeSharedRef.current = false;
    openConfirmModal({
      title: 'Empty your app data?',
      children: (
        <EmptyConfirmBody
          appName={appName}
          onIncludeSharedChange={(value) => {
            includeSharedRef.current = value;
          }}
        />
      ),
      labels: { confirm: 'Delete my data', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        emptyMutation.mutate({
          appBlockId: app.appBlockId,
          includeShared: includeSharedRef.current,
        }),
    });
  };

  if (!enabled) return null;
  return (
    <AppStorageCardView
      flat={flat}
      data={query.data}
      onEmpty={handleEmpty}
      emptyingId={emptyMutation.isPending ? emptyMutation.variables?.appBlockId : null}
    />
  );
}
