import { Stack, Table, Text } from '@mantine/core';
import { feeToRatio, tierCapRows } from '@civitai/buzz';

// Rendered from `tierCapRows()` rather than transcribed, so these numbers cannot drift from the caps the
// server enforces. Creator Studio shows the same table (TierCapsTable.svelte) off the same helper.
const fmt = (n: number | null) => (n === null ? 'Unlimited' : n.toLocaleString());

const feeRatio = (perGeneration: number, noun: string) => {
  const { buzz, images } = feeToRatio(perGeneration);
  return `${buzz.toLocaleString()} ⚡ / ${images} ${noun}${images === 1 ? '' : 's'}`;
};

export const TierCapsTable = () => {
  const rows = tierCapRows();

  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Text size="sm" fw={600}>
          Licensing fees{' '}
          <Text component="span" size="sm" c="dimmed" fw={400}>
            — earned per generation
          </Text>
        </Text>
        <Table.ScrollContainer minWidth={520}>
          <Table striped withTableBorder verticalSpacing="xs" fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Tier</Table.Th>
                <Table.Th ta="right">Checkpoint · image</Table.Th>
                <Table.Th ta="right">Checkpoint · video</Table.Th>
                <Table.Th ta="right">Other types · image</Table.Th>
                <Table.Th ta="right">Other types · video</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr key={row.tier}>
                  <Table.Td fw={600}>{row.label}</Table.Td>
                  <Table.Td ta="right">{feeRatio(row.image.feeCheckpoint, 'image')}</Table.Td>
                  <Table.Td ta="right">{feeRatio(row.video.feeCheckpoint, 'video')}</Table.Td>
                  <Table.Td ta="right">{feeRatio(row.image.feeOther, 'image')}</Table.Td>
                  <Table.Td ta="right">{feeRatio(row.video.feeOther, 'video')}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Stack>

      <Stack gap={4}>
        <Text size="sm" fw={600}>
          Paid access{' '}
          <Text component="span" size="sm" c="dimmed" fw={400}>
            — one-time price to unlock a version
          </Text>
        </Text>
        <Table.ScrollContainer minWidth={420}>
          <Table striped withTableBorder verticalSpacing="xs" fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Tier</Table.Th>
                <Table.Th ta="right">Image models</Table.Th>
                <Table.Th ta="right">Video models</Table.Th>
                <Table.Th ta="right">Permanent gates</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row) => (
                <Table.Tr key={row.tier}>
                  <Table.Td fw={600}>{row.label}</Table.Td>
                  <Table.Td ta="right">{fmt(row.image.paidAccessPrice)} ⚡</Table.Td>
                  <Table.Td ta="right">{fmt(row.video.paidAccessPrice)} ⚡</Table.Td>
                  <Table.Td ta="right">{fmt(row.permanentGates)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Stack>

      <Stack gap={4}>
        <Text size="xs" c="dimmed">
          A version&apos;s base model decides whether it prices as image or video — video allows
          more because it costs more to generate.
        </Text>
        <Text size="xs" c="dimmed">
          Caps limit how much you can charge, not whether you can charge. An existing price above
          your cap keeps earning at the cap and is restored in full if you upgrade — it&apos;s never
          rewritten.
        </Text>
      </Stack>
    </Stack>
  );
};
