import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { useDisclosure } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import { trpc } from '~/utils/trpc';
import {
  Text,
  Card,
  Stack,
  Group,
  Title,
  Button,
  Box,
  LoadingOverlay,
  Center,
  Paper,
  Badge,
  Progress,
  UnstyledButton,
} from '@mantine/core';
import {
  IconPlus,
  IconTrash,
  IconCoin,
  IconCoinOff,
  IconCalendar,
  IconClock,
} from '@tabler/icons-react';
import { formatDate } from '~/utils/date-helpers';
import { ApiKeyModal } from '~/components/Account/ApiKeyModal';
import {
  API_KEY_DEEPLINK_PARAMS,
  parseApiKeyDeeplink,
  type ApiKeyDeeplinkPrefill,
} from '~/components/Account/apiKeyDeeplink';
import { EditBuzzLimitModal } from '~/components/Account/EditBuzzLimitModal';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { getScopeLabel } from '~/shared/constants/token-scope.constants';
import { abbreviateNumber } from '~/utils/number-helpers';
import type { BuzzLimit } from '~/server/schema/api-key.schema';
import { budgetsToSimpleBuzzLimit } from '~/server/schema/api-key.schema';

const periodLabels: Record<'day' | 'week' | 'month', string> = {
  day: '24h',
  week: '7d',
  month: '30d',
};

function getScopeBadgeColor(label: string): string {
  switch (label) {
    case 'Full Access':
      return 'red';
    case 'Read Only':
      return 'green';
    case 'Creator':
      return 'blue';
    case 'AI Services':
      return 'violet';
    case 'Custom':
      return 'yellow';
    default:
      return 'gray';
  }
}

export function ApiKeysCard() {
  const utils = trpc.useUtils();
  const features = useFeatureFlags();

  const router = useRouter();
  const [opened, { open, close }] = useDisclosure(false);
  // When the modal was opened via a deeplink (e.g. the App Blocks CLI scaffold's
  // "create an API key" link), this carries the prefilled name + scope; null for
  // a normal manual open. Remounting the modal on this (the `key` below) lets its
  // internal form pick up the prefill.
  const [prefill, setPrefill] = useState<ApiKeyDeeplinkPrefill | null>(null);
  const [editLimitFor, setEditLimitFor] = useState<{
    id: number;
    name: string;
    buzzLimit: BuzzLimit | null;
  } | null>(null);

  // Latch so the deeplink is handled at most once per page load, independent of
  // the effect's dep array. The param-strip below already prevents re-entry on
  // the current deps, but this keeps correctness if the deps ever change (e.g. a
  // future edit adds `router.query`, which the shallow replace would re-trigger).
  const deeplinkHandled = useRef(false);

  // Deeplink: `?addApiKey=1&name=...&scope=AIServices` opens the Add-API-Key
  // modal pre-filled, then strips the params so a refresh/back doesn't re-open.
  // Prefill only — the user still reviews + clicks Generate (no silent mint).
  useEffect(() => {
    if (!router.isReady || deeplinkHandled.current) return;
    const parsed = parseApiKeyDeeplink(router.query);
    if (!parsed) return;
    deeplinkHandled.current = true;
    setPrefill(parsed);
    open();
    const nextQuery = { ...router.query };
    for (const key of API_KEY_DEEPLINK_PARAMS) delete nextQuery[key];
    void router.replace({ pathname: router.pathname, query: nextQuery }, undefined, {
      shallow: true,
    });
    // Latched above; safe to run on isReady transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  const handleCloseModal = () => {
    close();
    setPrefill(null);
  };

  const { data: apiKeys = [], isLoading } = trpc.apiKey.getAllUserKeys.useQuery({});
  const { data: spendEntries = [] } = trpc.apiKey.getSpend.useQuery(undefined, {
    enabled: features.apiKeyBuzzLimit && apiKeys.some((k) => !!k.buzzLimit),
    staleTime: 30_000,
  });

  const spendMap = new Map<number, number>();
  for (const entry of spendEntries) {
    if (entry.type === 'apiKey' && typeof entry.id === 'number') {
      spendMap.set(entry.id, entry.spend);
    }
  }

  const deleteApiKeyMutation = trpc.apiKey.delete.useMutation({
    async onSuccess() {
      await utils.apiKey.getAllUserKeys.invalidate();
    },
  });

  const handleDeleteApiKey = (id: number) => {
    openConfirmModal({
      title: 'Delete API Key',
      children: <Text size="sm">Are you sure you want to delete this API Key?</Text>,
      centered: true,
      labels: { confirm: 'Delete API Key', cancel: "No, don't delete it" },
      confirmProps: { color: 'red' },
      onConfirm: () => deleteApiKeyMutation.mutateAsync({ id }),
    });
  };

  return (
    <>
      <Card withBorder>
        <Stack gap={0}>
          <Group align="start" justify="space-between">
            <Title order={2}>API Keys</Title>
            <Button
              size="compact-sm"
              leftSection={<IconPlus size={14} stroke={1.5} />}
              onClick={() => {
                setPrefill(null);
                open();
              }}
            >
              Add API key
            </Button>
          </Group>
          <Text c="dimmed" size="sm">
            You can use API keys to interact with the site through the API as your user. These
            should not be shared with anyone.
          </Text>
        </Stack>
        <Box mt="md" style={{ position: 'relative' }}>
          <LoadingOverlay visible={isLoading} />
          {apiKeys.length > 0 ? (
            <Stack gap="sm">
              {apiKeys.map((apiKey) => {
                const scopeLabel = getScopeLabel(apiKey.tokenScope);
                const buzzLimit = apiKey.buzzLimit as BuzzLimit | null;
                const hasLimit = !!buzzLimit && buzzLimit.length > 0;
                const spend = hasLimit ? spendMap.get(apiKey.id) ?? 0 : 0;
                const openLimitEditor = () =>
                  setEditLimitFor({ id: apiKey.id, name: apiKey.name, buzzLimit });

                const simpleLimit = budgetsToSimpleBuzzLimit(buzzLimit);
                return (
                  <Paper key={apiKey.id} withBorder p="md" radius="md">
                    <Stack gap="xs">
                      {/* Header row: name + scope inline, delete on right */}
                      <Group justify="space-between" align="center" wrap="nowrap">
                        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                          <Text
                            fw={600}
                            size="sm"
                            lineClamp={1}
                            title={apiKey.name}
                            style={{ minWidth: 0 }}
                          >
                            {apiKey.name}
                          </Text>
                          <Badge size="sm" variant="light" color={getScopeBadgeColor(scopeLabel)}>
                            {scopeLabel}
                          </Badge>
                        </Group>
                        <LegacyActionIcon
                          variant="subtle"
                          color="red"
                          onClick={() => handleDeleteApiKey(apiKey.id)}
                          title="Delete API key"
                        >
                          <IconTrash size={16} stroke={1.5} />
                        </LegacyActionIcon>
                      </Group>

                      {/* Meta row: created · last used · spend limit (inline) */}
                      <Group gap="md" wrap="nowrap" align="center">
                        <Group gap={4} wrap="nowrap">
                          <IconCalendar size={12} color="var(--mantine-color-dimmed)" />
                          <Text size="xs" c="dimmed">
                            {formatDate(apiKey.createdAt)}
                          </Text>
                        </Group>
                        <Group gap={4} wrap="nowrap">
                          <IconClock size={12} color="var(--mantine-color-dimmed)" />
                          <Text size="xs" c="dimmed">
                            {apiKey.lastUsedAt ? formatDate(apiKey.lastUsedAt) : 'Never used'}
                          </Text>
                        </Group>
                        {features.apiKeyBuzzLimit &&
                          (hasLimit && simpleLimit ? (
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
                          ))}
                      </Group>
                    </Stack>
                  </Paper>
                );
              })}
            </Stack>
          ) : (
            <Paper radius="md" mt="lg" p="lg" style={{ position: 'relative' }} withBorder>
              <Center>
                <Stack gap={2}>
                  <Text fw="bold">There are no API keys in your account</Text>
                  <Text size="sm" c="dimmed">
                    Start by creating your first API Key to connect your apps.
                  </Text>
                </Stack>
              </Center>
            </Paper>
          )}
        </Box>
      </Card>
      <ApiKeyModal
        // Remount when switching between a manual open and a deeplink prefill so
        // the modal's internal form re-initializes from initialName/scope.
        key={prefill ? 'deeplink' : 'manual'}
        title="Create API Key"
        opened={opened}
        onClose={handleCloseModal}
        initialName={prefill?.name}
        initialTokenScope={prefill?.tokenScope}
      />
      {features.apiKeyBuzzLimit && editLimitFor && (
        <EditBuzzLimitModal
          opened={!!editLimitFor}
          onClose={() => setEditLimitFor(null)}
          subject={{ type: 'apiKey', id: editLimitFor.id }}
          name={editLimitFor.name}
          initialLimit={editLimitFor.buzzLimit}
        />
      )}
    </>
  );
}
