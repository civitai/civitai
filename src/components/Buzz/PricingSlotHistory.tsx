import { Anchor, Divider, Loader, Popover, Stack, Table, Text } from '@mantine/core';
import { useState } from 'react';
import { PRICING_SLOT_EXPLAINER, formatFeeRatio } from '@civitai/buzz';
import type { RouterOutput } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

// What each price charges now — the ledger stores no amount, so this is the version's current price
// rather than the one it was priced at.
function priceLabel({
  licensingFee,
  accessPrice,
  generationPrice,
}: {
  licensingFee: number | null;
  accessPrice: number | null;
  generationPrice: number | null;
}) {
  const parts: string[] = [];
  // formatFeeRatio, not the raw per-image number: the default fee is 0.1/image, which every other
  // surface shows as "1 ⚡ / 10 images".
  if (licensingFee) parts.push(`${formatFeeRatio(licensingFee)} license fee`);
  if (accessPrice) parts.push(`${accessPrice.toLocaleString()} ⚡ access`);
  if (generationPrice) parts.push(`${generationPrice.toLocaleString()} ⚡ generation`);
  // Not 'it will be released on your next save': the row is still here, and a release can refuse for
  // reasons we can't distinguish — releasePricingSlot fails closed when it can't tell.
  return parts.length ? parts.join(' · ') : 'No current price — this slot has not been returned';
}

// A deleted model keeps its slot but has no page, and a name we no longer hold means the row outlived
// its entity — say which without claiming a cause we cannot check.
function slotLabel({
  modelName,
  versionName,
  entityId,
}: {
  modelName: string | null;
  versionName: string | null;
  entityId: number;
}) {
  if (!modelName) return `#${entityId} — no longer available`;
  return versionName ? `${modelName} · ${versionName}` : modelName;
}

/** The slots the creator has spent, newest first. Opened from the monthly counter. */
export function PricingSlotHistory() {
  const [opened, setOpened] = useState(false);
  const { data, isLoading } = trpc.modelVersion.getPricingSlots.useQuery(undefined, {
    enabled: opened,
  });

  const thisMonth = data?.filter((slot) => slot.countsThisMonth) ?? [];
  const earlier = data?.filter((slot) => !slot.countsThisMonth) ?? [];

  return (
    <Popover
      width={420}
      withArrow
      withinPortal
      shadow="md"
      position="bottom-start"
      opened={opened}
      onChange={setOpened}
    >
      <Popover.Target>
        <Anchor component="button" type="button" size="xs" onClick={() => setOpened((o) => !o)}>
          What used my slots?
        </Anchor>
      </Popover.Target>
      <Popover.Dropdown mah={420} style={{ overflowY: 'auto' }}>
        <Stack gap="xs">
          <Text size="xs" c="dimmed">
            {PRICING_SLOT_EXPLAINER}
          </Text>
          {isLoading && <Loader size="xs" />}
          {!isLoading && data?.length === 0 && (
            <Text size="xs">You haven&apos;t priced any model versions yet.</Text>
          )}
          {!!data?.length && (
            <>
              <SlotTable
                title={`This month · ${thisMonth.length} ${
                  thisMonth.length === 1 ? 'slot' : 'slots'
                }`}
                slots={thisMonth}
              />
              {earlier.length > 0 && (
                <>
                  <Divider />
                  <SlotTable title="Priced earlier — not counted this month" slots={earlier} />
                </>
              )}
              <Text size="xs" c="dimmed">
                Amounts are what each version charges now. A price changed after it was set shows
                its current value.
              </Text>
            </>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

type Slot = RouterOutput['modelVersion']['getPricingSlots'][number];

function SlotTable({ title, slots }: { title: string; slots: Slot[] }) {
  return (
    <Stack gap={4}>
      <Text size="xs" fw={600}>
        {title}
      </Text>
      {slots.length === 0 ? (
        <Text size="xs" c="dimmed">
          Nothing yet.
        </Text>
      ) : (
        <Table fz="xs" verticalSpacing={4} horizontalSpacing="xs">
          <Table.Tbody>
            {slots.map((slot) => (
              <Table.Tr key={`${slot.entityType}-${slot.entityId}`}>
                <Table.Td c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  {formatDate(slot.createdAt)}
                </Table.Td>
                <Table.Td>
                  {slot.modelId ? (
                    <Anchor
                      href={`/models/${slot.modelId}?modelVersionId=${slot.entityId}`}
                      target="_blank"
                    >
                      {slotLabel(slot)}
                    </Anchor>
                  ) : (
                    <Text size="xs" c="dimmed">
                      {slotLabel(slot)}
                    </Text>
                  )}
                  <Text size="xs" c="dimmed">
                    {priceLabel(slot)}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
