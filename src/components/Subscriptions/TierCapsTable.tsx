import { Stack, Table, Text } from '@mantine/core';
import { MAX_LICENSING_FEE, VIDEO_CAP_MULTIPLIER, tierAllowanceRows } from '@civitai/buzz';

// Rendered from `tierAllowanceRows()` rather than transcribed, so these numbers cannot drift from what
// the server enforces. Creator Studio shows the same table (TierCapsTable.svelte) off the same helper.
const fmt = (n: number | null) => (n === null ? 'Unlimited' : n.toLocaleString());

export const TierCapsTable = () => {
  const rows = tierAllowanceRows();

  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Text size="sm" fw={600}>
          Model versions you can price each month{' '}
          <Text component="span" size="sm" c="dimmed" fw={400}>
            — a licensing fee or paid access
          </Text>
        </Text>
        <Table.ScrollContainer minWidth={320}>
          <Table striped withTableBorder verticalSpacing="xs" fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Tier</Table.Th>
                <Table.Th ta="right">Priced / month</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr key={row.tier}>
                  <Table.Td fw={600}>{row.label}</Table.Td>
                  <Table.Td ta="right">{fmt(row.monthlyPrices)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Stack>

      <Stack gap={4}>
        <Text size="xs" c="dimmed">
          A licensing fee or a permanent paid-access price each count once, per version, the first
          time you set one. Changing or removing a price you have already set costs nothing, and a
          timed early-access window never counts.
        </Text>
        <Text size="xs" c="dimmed">
          How much you charge is the same at every tier: up to {MAX_LICENSING_FEE.toLocaleString()}{' '}
          ⚡ per generation as a licensing fee (
          {(MAX_LICENSING_FEE * VIDEO_CAP_MULTIPLIER).toLocaleString()} ⚡ for video models), and
          any price you like for paid access.
        </Text>
      </Stack>
    </Stack>
  );
};
