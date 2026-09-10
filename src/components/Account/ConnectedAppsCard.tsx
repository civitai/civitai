import { useState } from 'react';
import { openConfirmModal } from '@mantine/modals';
import { trpc } from '~/utils/trpc';
import {
  Text,
  Stack,
  Group,
  Title,
  Box,
  LoadingOverlay,
  Center,
  Paper,
  Badge,
  Progress,
  UnstyledButton,
} from '@mantine/core';
import { CardOrSection } from '~/components/Account/SettingsLayout';
import {
  IconPlugConnected,
  IconTrash,
  IconShieldCheck,
  IconCalendar,
  IconCoin,
  IconCoinOff,
} from '@tabler/icons-react';
import { formatDate } from '~/utils/date-helpers';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { getScopeLabel } from '~/shared/constants/token-scope.constants';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { abbreviateNumber } from '~/utils/number-helpers';
import { EditBuzzLimitModal } from '~/components/Account/EditBuzzLimitModal';
import type { BuzzLimit } from '~/server/schema/api-key.schema';
import { budgetsToSimpleBuzzLimit } from '~/server/schema/api-key.schema';

const periodLabels: Record<'day' | 'week' | 'month', string> = {
  day: '24h',
  week: '7d',
  month: '30d',
};

export function ConnectedAppsCard({ flat }: { flat?: boolean } = {}) {
  const utils = trpc.useUtils();
  const [editLimitFor, setEditLimitFor] = useState<{
    clientId: string;
    name: string;
    buzzLimit: BuzzLimit | null;
  } | null>(null);
  const { data: apps = [], isLoading } = trpc.oauthConsent.getConnectedApps.useQuery();
  const { data: spendEntries = [] } = trpc.apiKey.getSpend.useQuery(undefined, {
    enabled: apps.some((a) => !!a.buzzLimit),
    staleTime: 30_000,
  });
  const spendMap = new Map<string, number>();
  for (const entry of spendEntries) {
    if (entry.type === 'oauth' && typeof entry.id === 'string') {
      spendMap.set(entry.id, entry.spend);
    }
  }
  const revokeMutation = trpc.oauthConsent.revokeApp.useMutation({
    onSuccess: () => {
      utils.oauthConsent.getConnectedApps.invalidate();
      showSuccessNotification({ message: 'App access revoked' });
    },
    onError: (error) => {
      showErrorNotification({ error: new Error(error.message) });
    },
  });

  const handleRevoke = (clientId: string, appName: string) => {
    openConfirmModal({
      title: 'Revoke App Access',
      children: (
        <Text size="sm">
          Are you sure you want to revoke access for <strong>{appName}</strong>? This will
          disconnect the app and delete all its tokens. You&apos;ll need to re-authorize if you want
          to use it again.
        </Text>
      ),
      labels: { confirm: 'Revoke Access', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => revokeMutation.mutate({ clientId }),
    });
  };

  if (apps.length === 0 && !isLoading) return null;

  return (
    <CardOrSection flat={flat} title="Connected apps">
      <Stack>
        {!flat && (
          <Group justify="space-between">
            <Group gap="xs">
              <IconPlugConnected size={20} />
              <Title order={4}>Connected Apps</Title>
            </Group>
          </Group>
        )}

        <Box pos="relative">
          <LoadingOverlay visible={isLoading} />
          {apps.length === 0 ? (
            <Center p="xl">
              <Text c="dimmed">No connected apps</Text>
            </Center>
          ) : (
            <Stack gap="sm">
              {apps.map((app) => {
                const buzzLimit = app.buzzLimit as BuzzLimit | null;
                const hasLimit = !!buzzLimit && buzzLimit.length > 0;
                const simpleLimit = budgetsToSimpleBuzzLimit(buzzLimit);
                const spend = hasLimit ? spendMap.get(app.clientId) ?? 0 : 0;
                const openLimitEditor = () =>
                  setEditLimitFor({ clientId: app.clientId, name: app.name, buzzLimit });

                return (
                  <Paper key={app.clientId} withBorder p="md" radius="md">
                    <Stack gap="xs">
                      {/* Header: name + scope badge inline, revoke on right */}
                      <Group justify="space-between" align="center" wrap="nowrap">
                        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                          <Text
                            fw={600}
                            size="sm"
                            lineClamp={1}
                            title={app.name}
                            style={{ minWidth: 0 }}
                          >
                            {app.name}
                          </Text>
                          {app.isVerified && (
                            <IconShieldCheck size={14} color="var(--mantine-color-green-6)" />
                          )}
                          <Badge size="sm" variant="light">
                            {getScopeLabel(app.scope)}
                          </Badge>
                        </Group>
                        <LegacyActionIcon
                          color="red"
                          variant="subtle"
                          onClick={() => handleRevoke(app.clientId, app.name)}
                          loading={revokeMutation.isPending}
                          title="Revoke access"
                        >
                          <IconTrash size={16} />
                        </LegacyActionIcon>
                      </Group>

                      {/* Meta line: authorized date · spend limit (inline) */}
                      <Group gap="md" wrap="nowrap" align="center">
                        <Group gap={4} wrap="nowrap">
                          <IconCalendar size={12} color="var(--mantine-color-dimmed)" />
                          <Text size="xs" c="dimmed">
                            {formatDate(app.authorizedAt)}
                          </Text>
                        </Group>
                        {hasLimit && simpleLimit ? (
                          (() => {
                            const pct = Math.min(100, (spend / simpleLimit.limit) * 100);
                            return (
                              <UnstyledButton
                                onClick={openLimitEditor}
                                title="Edit spend limit"
                                style={{ flex: 1, minWidth: 0 }}
                              >
                                <Group gap={4} wrap="nowrap">
                                  <IconCoin size={12} color="var(--mantine-color-dimmed)" />
                                  <Progress
                                    value={pct}
                                    size="sm"
                                    color={pct > 90 ? 'red' : pct > 60 ? 'yellow' : 'blue'}
                                    style={{ flex: 1, minWidth: 40 }}
                                  />
                                  <Text
                                    size="xs"
                                    c={pct > 90 ? 'red' : 'dimmed'}
                                    style={{ whiteSpace: 'nowrap', textDecoration: 'underline' }}
                                  >
                                    {abbreviateNumber(spend)} /{' '}
                                    {abbreviateNumber(simpleLimit.limit)} per{' '}
                                    {periodLabels[simpleLimit.period]}
                                  </Text>
                                </Group>
                              </UnstyledButton>
                            );
                          })()
                        ) : hasLimit ? (
                          <UnstyledButton onClick={openLimitEditor} title="Edit spend limit">
                            <Group gap={4} wrap="nowrap">
                              <IconCoin size={12} color="var(--mantine-color-dimmed)" />
                              <Text size="xs" c="dimmed" style={{ textDecoration: 'underline' }}>
                                Custom limit
                              </Text>
                            </Group>
                          </UnstyledButton>
                        ) : (
                          <UnstyledButton onClick={openLimitEditor} title="Set a spend limit">
                            <Group gap={4} wrap="nowrap">
                              <IconCoinOff size={12} color="var(--mantine-color-dimmed)" />
                              <Text size="xs" c="dimmed" style={{ textDecoration: 'underline' }}>
                                No limit
                              </Text>
                            </Group>
                          </UnstyledButton>
                        )}
                      </Group>

                      {app.description && (
                        <Text size="xs" c="dimmed" lineClamp={2}>
                          {app.description}
                        </Text>
                      )}
                    </Stack>
                  </Paper>
                );
              })}
            </Stack>
          )}
        </Box>
      </Stack>
      {editLimitFor && (
        <EditBuzzLimitModal
          opened={!!editLimitFor}
          onClose={() => setEditLimitFor(null)}
          subject={{ type: 'oauth', clientId: editLimitFor.clientId }}
          name={editLimitFor.name}
          initialLimit={editLimitFor.buzzLimit}
        />
      )}
    </CardOrSection>
  );
}
