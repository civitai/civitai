import { Anchor, Button, Paper, Popover, Stack, Table, Text } from '@mantine/core';
import type { CapTier } from '@civitai/buzz';
import { shouldUpsellAllowance, tierAllowanceRows } from '@civitai/buzz';

// Turns the monthly pricing allowance from a dead end into an upgrade nudge, beside the counter the
// creator is pressing against. Deliberately quiet — a small link, not a banner — and absent until they
// near their limit, or when the tier has nothing above it. `shouldUpsellAllowance` is shared with
// Creator Studio so both surfaces appear at the same moment.
export function CapUpsell({
  used,
  limit,
  capTier,
  title = 'New prices per month',
  expanded = false,
}: {
  /** Slots spent this calendar month. */
  used: number | null | undefined;
  limit: number;
  capTier: CapTier;
  title?: string;
  /** Render the tiers inline rather than behind the trigger, for a creator already at their limit. */
  expanded?: boolean;
}) {
  if (!expanded && !shouldUpsellAllowance({ used, limit, tier: capTier })) return null;

  const rows = tierAllowanceRows();
  const fmt = (n: number | null) => (n == null ? 'Unlimited' : `${n.toLocaleString()} / month`);

  const body = (
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
                  {fmt(row.monthlyPrices)}
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
  );

  if (expanded)
    return (
      <Paper withBorder p="xs" radius="md">
        {body}
      </Paper>
    );

  return (
    <Popover width={300} withArrow shadow="md" position="top-start" withinPortal>
      <Popover.Target>
        <Anchor component="button" type="button" size="xs">
          Want to price more models?
        </Anchor>
      </Popover.Target>
      <Popover.Dropdown>{body}</Popover.Dropdown>
    </Popover>
  );
}
