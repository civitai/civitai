import { Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconArrowRight, IconHistory } from '@tabler/icons-react';
import { ChecksCard } from '~/components/CreatorShop/ChecksCard';
import { CosmeticThumb } from '~/components/CreatorShop/CosmeticThumb';
import { CREATOR_SHOP_BORDER } from '~/components/CreatorShop/creator-shop.constants';
import type {
  CosmeticShopItemHistoryChange,
  CosmeticShopItemHistoryEntry,
} from '~/server/schema/cosmetic-shop.schema';
import { formatDate } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';

const fieldLabels: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  artwork: 'Artwork',
  offsets: 'Fit offsets',
  slug: 'Slug',
  uses: 'Uses per purchase',
  pricePerUse: 'Price per extra use',
  price: 'Price',
  quantity: 'Quantity',
};

const actionLabels: Record<string, string> = {
  approve: 'Approved & published',
  reject: 'Rejected',
  'request-changes': 'Requested changes',
  revert: 'Reverted to pending review',
};

const valueText = (value: CosmeticShopItemHistoryChange['from'], field: string) => {
  if (value === undefined || value === null || value === '') return 'none';
  if (typeof value === 'number')
    return field === 'price' || field === 'pricePerUse'
      ? `${numberWithCommas(value)} Buzz`
      : numberWithCommas(value);
  if (field === 'slug') return `:${value}:`;
  // Free text can be paragraphs long; the full value is on the item itself.
  return value.length > 60 ? `“${value.slice(0, 60)}…”` : `“${value}”`;
};

const changeText = (change: CosmeticShopItemHistoryChange) => {
  const label = fieldLabels[change.field] ?? change.field;
  if (change.field === 'artwork') return 'Artwork replaced';
  return `${label} ${valueText(change.from, change.field)} → ${valueText(change.to, change.field)}`;
};

const headline = (entry: CosmeticShopItemHistoryEntry) => {
  switch (entry.kind) {
    case 'submitted':
      return 'Submitted for review';
    case 'edited':
      return 'Edited by the creator';
    case 'takedown':
      return 'Taken down';
    default:
      return (entry.action && actionLabels[entry.action]) ?? 'Reviewed';
  }
};

// Artwork swaps carry the pre-swap url, so the previous art can be shown beside
// the current one — the single most common thing a re-review needs to compare.
function ArtworkSwap({ change }: { change: CosmeticShopItemHistoryChange }) {
  return (
    <Group gap={8} align="center">
      <Stack gap={2} align="center">
        <CosmeticThumb data={{ url: change.from }} name="Previous artwork" />
        <Text size="xs" c="dimmed">
          Before
        </Text>
      </Stack>
      <IconArrowRight size={14} color="var(--mantine-color-dimmed)" />
      <Stack gap={2} align="center">
        <CosmeticThumb data={{ url: change.to }} name="Replacement artwork" />
        <Text size="xs" c="dimmed">
          After
        </Text>
      </Stack>
    </Group>
  );
}

function HistoryRow({
  entry,
  actor,
  withBorder,
}: {
  entry: CosmeticShopItemHistoryEntry;
  actor: string;
  withBorder?: boolean;
}) {
  const artworkChange = entry.changes?.find((c) => c.field === 'artwork' && (c.from || c.to));
  return (
    <Stack
      gap={6}
      px="md"
      py={9}
      style={{ borderBottom: withBorder ? CREATOR_SHOP_BORDER : undefined }}
    >
      <Group gap={8} justify="space-between" wrap="nowrap" align="baseline">
        <Text size="sm" fw={500}>
          {headline(entry)}
        </Text>
        <Text size="xs" c="dimmed" className="whitespace-nowrap">
          {actor} · {formatDate(entry.at, 'MMM D, YYYY h:mm A')}
        </Text>
      </Group>
      {!!entry.changes?.length && (
        <Stack gap={2}>
          {entry.changes.map((change, i) => (
            <Text key={`${change.field}-${i}`} size="xs" c="dimmed">
              {changeText(change)}
            </Text>
          ))}
        </Stack>
      )}
      {!!artworkChange && <ArtworkSwap change={artworkChange} />}
      {!!entry.note && (
        <Text size="xs" c={entry.kind === 'edited' ? 'yellow' : 'dimmed'}>
          {entry.note}
        </Text>
      )}
    </Stack>
  );
}

/**
 * Newest-first log of everything that happened to a shop item. `creator` names
 * the actor when the event was theirs; anyone else (moderators) shows as an id,
 * matching how the rights affirmation attributes non-creators.
 */
export function HistoryCard({
  history,
  creator,
}: {
  history?: CosmeticShopItemHistoryEntry[];
  creator?: { id: number; username: string | null } | null;
}) {
  const entries = history ? [...history].reverse() : [];
  return (
    <ChecksCard
      icon={<IconHistory size={15} color="var(--mantine-color-dimmed)" />}
      title="History"
    >
      {entries.length ? (
        entries.map((entry, i) => (
          <HistoryRow
            key={`${entry.at}-${i}`}
            entry={entry}
            actor={
              creator && entry.userId === creator.id
                ? `@${creator.username ?? 'creator'}`
                : `user #${entry.userId}`
            }
            withBorder={i < entries.length - 1}
          />
        ))
      ) : (
        <Group gap={9} px="md" py={9} align="center">
          <IconAlertTriangle size={16} color="var(--mantine-color-yellow-5)" />
          <Text size="sm" c="dimmed">
            No history recorded — this item predates change tracking.
          </Text>
        </Group>
      )}
    </ChecksCard>
  );
}
