import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  NumberInput,
  Stack,
  Switch,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Draft = { enabled: boolean; awardAmount: string; cap: string };
type StoredOverride = { enabled?: boolean; awardAmount?: number; cap?: number };

/**
 * Reads the overrides as WRITTEN rather than the effective values, so an input
 * left empty means "use the compiled default" and clearing one removes the
 * override instead of freezing today's default as a literal.
 */
function storedOverrides(value: unknown, malformed: boolean): Record<string, StoredOverride> {
  if (malformed || typeof value !== 'object' || value === null) return {};
  const rewards = (value as { rewards?: unknown }).rewards;
  if (typeof rewards !== 'object' || rewards === null) return {};
  return rewards as Record<string, StoredOverride>;
}

const numberOrEmpty = (value: number | undefined) => (value === undefined ? '' : String(value));

/**
 * 🔴 Builds the WHOLE map, every time. `set` replaces the row, so a payload
 * containing only the rewards someone edited erases every other reward's
 * override — a one-line mistake with a blast radius across every reward, which
 * is why this is a separate function with its own tests rather than a loop
 * inside the submit handler.
 */
export function buildRewardsPayload({
  rewards,
  overrides,
  rows,
}: {
  rewards: { type: string; capOverridable: boolean }[];
  overrides: Record<string, StoredOverride>;
  rows: Record<string, Draft>;
}): Record<string, StoredOverride> {
  const payload: Record<string, StoredOverride> = {};

  // Keys the config names that no reward matches — an override staged ahead of a
  // deploy, which the read path ignores. Dropping them here would delete
  // someone's staged edit on the next unrelated save.
  for (const [type, override] of Object.entries(overrides))
    if (!rewards.some((reward) => reward.type === type)) payload[type] = override;

  for (const reward of rewards) {
    const row = rows[reward.type];
    if (!row) continue;

    const entry: StoredOverride = {};
    // Only what DIFFERS from the compiled default is stored, so a later change to
    // that default flows through instead of being frozen behind an override
    // written months earlier. An empty input therefore removes the override.
    if (!row.enabled) entry.enabled = false;
    if (row.awardAmount !== '') entry.awardAmount = Number(row.awardAmount);
    if (reward.capOverridable && row.cap !== '') entry.cap = Number(row.cap);

    if (Object.keys(entry).length) payload[reward.type] = entry;
  }

  return payload;
}

export function RewardConfigPanel() {
  const queryUtils = trpc.useUtils();
  const { data, isLoading } = trpc.rewardConfig.get.useQuery();
  // The live value the grant path uses, not one derived from the events table on
  // this page — that is paginated and not ordered by multiplier, so the active
  // event can be on another page.
  const { multipliers } = useUserMultipliers();
  const bonusMultiplier = multipliers.globalRewardsBonus;
  const [drafts, setDrafts] = useState<Record<string, Draft> | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const overrides = useMemo(
    () => storedOverrides(data?.stored.value, data?.stored.malformed ?? false),
    [data?.stored.value, data?.stored.malformed]
  );

  const initial = useMemo(() => {
    const next: Record<string, Draft> = {};
    for (const reward of data?.rewards ?? []) {
      const override = overrides[reward.type] ?? {};
      next[reward.type] = {
        enabled: override.enabled ?? true,
        awardAmount: numberOrEmpty(override.awardAmount),
        cap: numberOrEmpty(override.cap),
      };
    }
    return next;
  }, [data?.rewards, overrides]);

  const rows = drafts ?? initial;
  const setRow = (type: string, patch: Partial<Draft>) => {
    setConflict(null);
    setDrafts({ ...rows, [type]: { ...rows[type], ...patch } });
  };

  const setMutation = trpc.rewardConfig.set.useMutation({
    onSuccess: async () => {
      setDrafts(null);
      setConflict(null);
      await queryUtils.rewardConfig.get.invalidate();
      showSuccessNotification({ message: 'Reward config saved.' });
    },
    onError: (error) => {
      if (error.data?.code === 'CONFLICT') setConflict(error.message);
      else showErrorNotification({ title: 'Could not save', error: new Error(error.message) });
    },
  });

  function handleSave(force = false) {
    if (!data) return;

    const rewards = buildRewardsPayload({ rewards: data.rewards, overrides, rows });

    setMutation.mutate({ rewards, expectedHash: data.stored.hash, force });
  }

  if (isLoading) return <PageLoader />;
  if (!data) return null;

  const dirty = drafts !== null;

  return (
    <Stack gap="md">
      <Stack gap={0}>
        <Title order={2}>Reward Configuration</Title>
        <Text size="sm" c="dimmed">
          Turn a Buzz reward off, or change what it pays, without a deploy. Empty means the value
          compiled into the reward. Changes take up to a minute to reach every server.
        </Text>
      </Stack>

      {bonusMultiplier && bonusMultiplier > 1 ? (
        <Alert icon={<IconInfoCircle size={18} />} color="blue">
          A <b>{bonusMultiplier}x</b> bonus event is live. The numbers below are base values — at
          grant time the award <b>and the cap</b> are both multiplied by the member&apos;s
          membership multiplier and this event, so a member&apos;s real daily ceiling today is{' '}
          <Code>cap × membership × {bonusMultiplier}</Code>.
        </Alert>
      ) : null}

      {data.stored.malformed ? (
        <Alert icon={<IconAlertTriangle size={18} />} color="red" title="Stored config unreadable">
          <Stack gap="xs">
            <Text size="sm">
              The saved row does not match the expected shape, so the values below are the compiled
              defaults rather than what is stored. Saving would discard whatever is in the row that
              cannot be shown here.
            </Text>
            <Code block>{JSON.stringify(data.stored.value, null, 2)}</Code>
            <Group>
              <Button color="red" variant="light" onClick={() => handleSave(true)}>
                Overwrite the stored row
              </Button>
            </Group>
          </Stack>
        </Alert>
      ) : null}

      {conflict ? (
        <Alert icon={<IconAlertTriangle size={18} />} color="orange" title="Someone else saved">
          <Stack gap="xs">
            <Text size="sm">{conflict}</Text>
            <Group>
              <Button
                variant="light"
                onClick={() => {
                  setDrafts(null);
                  setConflict(null);
                  queryUtils.rewardConfig.get.invalidate();
                }}
              >
                Reload their version
              </Button>
            </Group>
          </Stack>
        </Alert>
      ) : null}

      <Table striped withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Reward</Table.Th>
            <Table.Th style={{ width: 110 }}>Enabled</Table.Th>
            <Table.Th style={{ width: 160 }}>Award</Table.Th>
            <Table.Th style={{ width: 160 }}>Cap</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {data.rewards.map((reward) => {
            const row = rows[reward.type];
            const refusedAward = reward.rejected.includes('awardAmount');
            const refusedCap = reward.rejected.includes('cap');
            const otherRefused = reward.rejected.filter(
              (field) => !['awardAmount', 'cap', 'enabled'].includes(field)
            );

            return (
              <Table.Tr key={reward.type}>
                <Table.Td>
                  <Stack gap={2}>
                    <Group gap="xs">
                      <Text fw={500}>{reward.type}</Text>
                      {!reward.visible ? (
                        <Badge size="xs" color="gray">
                          not listed
                        </Badge>
                      ) : null}
                    </Group>
                    {reward.rejected.includes('enabled') ? (
                      <Text size="xs" c="red">
                        The stored `enabled` could not be read, so this reward is off.
                      </Text>
                    ) : null}
                    {otherRefused.length ? (
                      <Text size="xs" c="red">
                        Unrecognised {otherRefused.length === 1 ? 'key' : 'keys'} in the stored row:{' '}
                        {otherRefused.join(', ')}. Saving here removes {}
                        {otherRefused.length === 1 ? 'it' : 'them'}.
                      </Text>
                    ) : null}
                  </Stack>
                </Table.Td>
                <Table.Td>
                  <Switch
                    checked={row.enabled}
                    onChange={(event) =>
                      setRow(reward.type, { enabled: event.currentTarget.checked })
                    }
                  />
                </Table.Td>
                <Table.Td>
                  <NumberInput
                    value={row.awardAmount}
                    onChange={(value) => setRow(reward.type, { awardAmount: String(value ?? '') })}
                    placeholder={String(reward.defaults.awardAmount)}
                    min={0}
                    allowDecimal={false}
                    error={
                      refusedAward
                        ? `Refused. Using the default, ${reward.defaults.awardAmount}.`
                        : undefined
                    }
                  />
                </Table.Td>
                <Table.Td>
                  {reward.capOverridable ? (
                    <NumberInput
                      value={row.cap}
                      onChange={(value) => setRow(reward.type, { cap: String(value ?? '') })}
                      placeholder={
                        reward.defaults.cap === undefined ? 'none' : String(reward.defaults.cap)
                      }
                      min={0}
                      allowDecimal={false}
                      error={
                        refusedCap
                          ? `Refused. Using the default, ${reward.defaults.cap ?? 'none'}.`
                          : undefined
                      }
                    />
                  ) : (
                    <Tooltip
                      multiline
                      w={260}
                      label="This reward has more than one cap, so a single number cannot say which one it means. Change it in code."
                    >
                      <Text size="sm" c="dimmed">
                        multiple caps
                      </Text>
                    </Tooltip>
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>

      <Group>
        <Button
          onClick={() => handleSave()}
          loading={setMutation.isPending}
          disabled={!dirty || data.stored.malformed}
        >
          Save
        </Button>
        {dirty ? (
          <Button variant="subtle" onClick={() => setDrafts(null)}>
            Discard changes
          </Button>
        ) : null}
      </Group>
    </Stack>
  );
}
