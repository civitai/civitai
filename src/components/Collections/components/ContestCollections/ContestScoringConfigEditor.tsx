import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Group,
  Loader,
  NumberInput,
  Paper,
  Radio,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import type {
  ContestScoreSignal,
  ContestScoringConfigValues,
  ContestScoringScope,
} from '~/server/schema/contest-score.schema';
import { contestScoreSignals } from '~/server/schema/contest-score.schema';
import { formatDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const signalLabels: Record<ContestScoreSignal, string> = {
  imageAuthors: 'Creators',
  reactors: 'Reactions',
  downloaders: 'Downloads',
  generators: 'Generations',
  collectors: 'Collects',
};

const toNumber = (value: string | number) =>
  typeof value === 'number' ? value : Number(value) || 0;

export function ContestScoringConfigEditor({ collectionId }: { collectionId: number }) {
  const queryUtils = trpc.useUtils();
  const { data, isLoading, error } = trpc.contestScore.getConfig.useQuery({ collectionId });

  const [scope, setScope] = useState<ContestScoringScope>('collection');
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState('');
  const [values, setValues] = useState<ContestScoringConfigValues | null>(null);

  // Seeded from whichever row is live for this contest, so an edit starts from what
  // the last run actually used rather than from an empty form.
  useEffect(() => {
    if (!data || values) return;
    const source = data.collection ?? data.global;
    if (!source) return;
    const { version, updatedById, updatedByUsername, updatedAt, ...rest } = source;
    setValues(rest);
  }, [data, values]);

  const setConfig = trpc.contestScore.setConfig.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Scoring config saved' });
      setAcknowledged(false);
      await Promise.all([
        queryUtils.contestScore.getConfig.invalidate({ collectionId }),
        queryUtils.contestScore.getCommunityScore.invalidate({ collectionId }),
      ]);
    },
    onError: (error) =>
      showErrorNotification({ title: 'Failed to save', error: new Error(error.message) }),
  });

  if (error)
    return (
      <Alert color="red" title="Scoring config unavailable">
        {error.message}
      </Alert>
    );

  if (isLoading || !values)
    return (
      <Group justify="center" py="md">
        <Loader />
      </Group>
    );

  const live = data?.collection ?? data?.global;
  const global = scope === 'global';
  const canSave = !global || acknowledged;

  const update = (patch: Partial<ContestScoringConfigValues>) =>
    setValues((current) => (current ? { ...current, ...patch } : current));

  return (
    <Stack gap="md">
      <Stack gap={4}>
        <Text size="sm" c="dimmed">
          {data?.effectiveScope === 'collection'
            ? 'This contest has its own scoring config.'
            : 'This contest currently uses the global config.'}
        </Text>
        {live?.updatedAt && (
          <Text size="xs" c="dimmed">
            Last changed by {live.updatedByUsername ?? `user ${live.updatedById}`} on{' '}
            {formatDate(live.updatedAt, 'MMM D, YYYY h:mm A')} (version {live.version})
          </Text>
        )}
      </Stack>

      <Radio.Group
        label="Save to"
        value={scope}
        onChange={(value) => {
          setScope(value as ContestScoringScope);
          setAcknowledged(false);
        }}
      >
        <Stack gap="xs" mt="xs">
          <Radio
            value="collection"
            label="This contest only"
            description="Creates or updates this collection's own config. Nothing else changes."
          />
          <Radio
            value="global"
            label="All contests"
            description="Rewrites the global fallback every contest without its own config reads — including contests that do not exist yet."
          />
        </Stack>
      </Radio.Group>

      {global && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} title="This is the global config">
          Saving here changes scoring for every current and future contest that has no config of its
          own. If you only meant to tune this contest, choose &ldquo;This contest only&rdquo;.
          <Checkbox
            mt="sm"
            color="red"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.currentTarget.checked)}
            label="I understand this affects every contest"
          />
        </Alert>
      )}

      <Divider label="Weights" labelPosition="left" />
      <SimpleGrid cols={{ base: 2, md: 5 }}>
        {contestScoreSignals.map((signal) => (
          <NumberInput
            key={signal}
            label={signalLabels[signal]}
            value={values.weights[signal]}
            onChange={(value) =>
              update({ weights: { ...values.weights, [signal]: toNumber(value) } })
            }
            decimalScale={4}
            step={0.05}
          />
        ))}
      </SimpleGrid>

      <Divider label="Minimum normalization denominator" labelPosition="left" />
      <SimpleGrid cols={{ base: 2, md: 5 }}>
        {contestScoreSignals.map((signal) => (
          <NumberInput
            key={signal}
            label={signalLabels[signal]}
            value={values.minDenominator[signal]}
            onChange={(value) =>
              update({ minDenominator: { ...values.minDenominator, [signal]: toNumber(value) } })
            }
            min={0}
          />
        ))}
      </SimpleGrid>

      <Divider label="Gates" labelPosition="left" />
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <NumberInput
          label="Age gate (days)"
          description="Accounts registered inside this many days before the contest opened are disqualified."
          value={values.ageGateDays}
          onChange={(value) => update({ ageGateDays: toNumber(value) })}
          min={0}
        />
        <NumberInput
          label="Max engagers"
          description="Above this, the banned/deleted refinement is skipped and the run is flagged degraded."
          value={values.maxEngagers}
          onChange={(value) => update({ maxEngagers: toNumber(value) })}
          min={1}
        />
        <NumberInput
          label="Farm IP — min peers"
          description="Distinct contest engagers sharing an IP before it is treated as a farm."
          value={values.farmIp.minPeers}
          onChange={(value) => update({ farmIp: { ...values.farmIp, minPeers: toNumber(value) } })}
          min={1}
        />
        <NumberInput
          label="Farm IP — min entries"
          description="Entries a single-creator engager must touch to be surfaced as a candidate."
          value={values.farmIp.minEntries}
          onChange={(value) =>
            update({ farmIp: { ...values.farmIp, minEntries: toNumber(value) } })
          }
          min={1}
        />
      </SimpleGrid>

      <TextInput
        label="Reason"
        placeholder="Why is this changing? (recorded in the audit log)"
        value={reason}
        onChange={(event) => setReason(event.currentTarget.value)}
        maxLength={500}
      />

      <Paper withBorder p="sm" radius="md">
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            Saving bumps the config version, which invalidates every cached run for this contest.
          </Text>
          <Button
            color={global ? 'red' : undefined}
            loading={setConfig.isPending}
            disabled={!canSave}
            onClick={() =>
              setConfig.mutate({
                collectionId,
                scope,
                config: values,
                reason: reason.trim() || undefined,
              })
            }
          >
            {global ? 'Save for ALL contests' : 'Save for this contest'}
          </Button>
        </Group>
      </Paper>
    </Stack>
  );
}
