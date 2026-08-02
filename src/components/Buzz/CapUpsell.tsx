import { Anchor, Button, Popover, Stack, Table, Text } from '@mantine/core';
import type { CapTier } from '@civitai/buzz';
import { capUpsellRows, shouldUpsellCap } from '@civitai/buzz';

// Turns a monetization cap from a dead end into an upgrade nudge, beside the input the creator is
// pressing against. Deliberately quiet — a small link, not a banner — and absent until the value nears
// the ceiling, or when the tier has nothing above it. `shouldUpsellCap` is shared with Creator Studio so
// both surfaces appear at the same moment.
//
// `capFor` must be the SAME expression that bounds the input. Passing the function rather than a table is
// what stops the popover quoting a number the field beside it contradicts — model type and media type are
// already baked in by the caller.
export function CapUpsell({
  value,
  cap,
  capTier,
  capFor,
  title,
  perLabel,
}: {
  value: number | null | undefined;
  cap: number;
  capTier: CapTier;
  capFor: (tier: CapTier) => number;
  title: string;
  /** Denominator for a ratio-domain cap, e.g. '10 generations'. Omitted for flat prices. */
  perLabel?: string;
}) {
  if (!shouldUpsellCap({ value, cap, tier: capTier })) return null;

  const rows = capUpsellRows(capFor);
  const fmt = (n: number) =>
    !Number.isFinite(n)
      ? 'Unlimited'
      : perLabel
      ? `${n.toLocaleString()} ⚡ / ${perLabel}`
      : `${n.toLocaleString()} ⚡`;

  return (
    <Popover width={300} withArrow shadow="md" position="top-start" withinPortal>
      <Popover.Target>
        <Anchor component="button" type="button" size="xs">
          Want to charge more?
        </Anchor>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text size="sm" fw={500}>
            {title}
          </Text>
          <Table fz="xs" verticalSpacing={4} horizontalSpacing="xs">
            <Table.Tbody>
              {rows.map((row) => {
                const isCurrent = row.tier === capTier;
                return (
                  <Table.Tr key={row.tier}>
                    <Table.Td fw={isCurrent ? 600 : 400} c={isCurrent ? undefined : 'dimmed'}>
                      {row.label}
                      {isCurrent && (
                        <Text component="span" size="xs" c="blue" ml={4}>
                          · you
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td
                      ta="right"
                      fw={isCurrent ? 600 : 400}
                      c={isCurrent ? undefined : 'dimmed'}
                    >
                      {fmt(row.cap)}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
          <Button
            component="a"
            href="/pricing?buzzType=green"
            target="_blank"
            size="xs"
            variant="light"
            fullWidth
          >
            See membership options
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
