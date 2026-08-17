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
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import type { Draft } from '~/components/Rewards/reward-config-panel.utils';
import {
  buildSetInput,
  initialDrafts,
  isStaleConflict,
  storedOverrides,
} from '~/components/Rewards/reward-config-panel.utils';
import { formatRewardsBoost } from '~/utils/buzz';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function RewardConfigPanel() {
  const queryUtils = trpc.useUtils();
  const { data, isLoading, error } = trpc.rewardConfig.get.useQuery();
  // The live value the grant path uses, not one derived from the events table on
  // this page — that is paginated and not ordered by multiplier, so the active
  // event can be on another page.
  const { multipliers } = useUserMultipliers();
  const bonusMultiplier = multipliers.globalRewardsBonus;
  const [drafts, setDrafts] = useState<Record<string, Draft> | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // The two CONFLICT causes are distinguished by which one reloading can fix.
  const conflictIsStale = !!conflict && isStaleConflict(conflict);

  const overrides = useMemo(
    () => storedOverrides(data?.stored.value, data?.stored.malformed ?? false),
    [data?.stored.value, data?.stored.malformed]
  );

  const initial = useMemo(
    () => initialDrafts(data?.rewards ?? [], overrides, { malformed: data?.stored.malformed }),
    [data?.rewards, overrides, data?.stored.malformed]
  );

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
    onError: (saveError) => {
      if (saveError.data?.code === 'CONFLICT') setConflict(saveError.message);
      else showErrorNotification({ title: 'Could not save', error: new Error(saveError.message) });
    },
  });

  function handleSave(force = false) {
    if (!data) return;

    setMutation.mutate(
      buildSetInput({ rewards: data.rewards, overrides, rows, hash: data.stored.hash, force })
    );
  }

  if (isLoading) return <PageLoader />;

  // Not `return null`: this section vanishing while the bonus-events table below
  // renders normally reads as "not built yet" rather than "erroring", and the
  // query fans out over every reward so a single one throwing takes it down.
  if (error || !data)
    return (
      <Alert icon={<IconAlertTriangle size={18} />} color="red" title="Reward config unavailable">
        <Stack gap="xs">
          <Text size="sm">
            The reward configuration could not be loaded, so nothing here can be changed right now.
            Rewards are still paying whatever the stored config says.
          </Text>
          {error ? <Code block>{error.message}</Code> : null}
        </Stack>
      </Alert>
    );

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
          A <b>{formatRewardsBoost(bonusMultiplier)}</b> bonus event is live. The numbers below are
          base values — at grant time the award <b>and the cap</b> are both multiplied by the
          member&apos;s membership multiplier and this event, so a member&apos;s real daily ceiling
          today is <Code>cap × membership × {bonusMultiplier}</Code>.
        </Alert>
      ) : null}

      {data.stored.malformed ? (
        <Alert icon={<IconAlertTriangle size={18} />} color="red" title="Stored config unreadable">
          <Stack gap="xs">
            <Text size="sm">
              The saved row does not match the expected shape. The table below shows what each
              reward is <b>doing right now</b> — switches, awards and caps all reflect what the
              grant path resolved from this row, not what the row says.
            </Text>
            <Text size="sm">
              Overwriting replaces the whole row with what the table shows. Anything else in it — a
              stray key, a value the resolver refused — is discarded. An award or cap{' '}
              <b>equal to its compiled default</b> is not carried over either: the row cannot say
              whether it was set deliberately or simply defaulted, so it goes back to following the
              default if that default ever changes.
            </Text>
            <Code block>{JSON.stringify(data.stored.value, null, 2)}</Code>
            <Group>
              <PopConfirm
                message="Replace the stored row with what the table shows? Anything else in it is discarded, including any award or cap that matches its compiled default."
                onConfirm={() => handleSave(true)}
                withinPortal
              >
                <Button color="red" variant="light" loading={setMutation.isPending}>
                  Overwrite the stored row
                </Button>
              </PopConfirm>
            </Group>
          </Stack>
        </Alert>
      ) : null}

      {/* CONFLICT covers two unrelated refusals. Reloading fixes one of them and
          is useless for the other, so the heading and the button follow the
          message rather than assuming the common case. */}
      {conflict ? (
        <Alert
          icon={<IconAlertTriangle size={18} />}
          color="orange"
          title={conflictIsStale ? 'Someone else saved' : 'Stored config cannot be read'}
        >
          <Stack gap="xs">
            <Text size="sm">{conflict}</Text>
            {conflictIsStale ? (
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
            ) : (
              <Text size="sm">
                Reloading will not help — the row on the server is unreadable. Fix it directly, or
                use the overwrite above, which replaces it with what is shown here.
              </Text>
            )}
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
                        {/* Names the overwrite, not Save: an unrecognised key implies the
                            row is malformed, which is the one state where Save is disabled. */}
                        Unrecognised {otherRefused.length === 1 ? 'key' : 'keys'} in the stored row:{' '}
                        {otherRefused.join(', ')}. Overwriting the stored row removes {}
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
