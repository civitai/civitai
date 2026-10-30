import { Alert, Badge, Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import {
  CREATOR_BOX_WEIGHT_TOTAL,
  CREATOR_BOX_WORST_DRAW_MULTIPLE,
} from '@civitai/shared/creator-box-rules';
import { CosmeticThumb } from '~/components/CreatorShop/CosmeticThumb';
import type { MysteryPackReview } from '~/server/services/creator-mystery-pack-review.service';
import { SHELF_SALES_VALUE_THRESHOLD } from '~/server/schema/creator-shop.schema';
import { daysFromNow } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';

type Bounds = NonNullable<NonNullable<MysteryPackReview['proposed']>['bounds']>;
type Tier = { key: string; name: string; weight: number | null; count: number };
type Content = {
  tier: string;
  cosmeticId: number;
  value: number | null;
  listed?: boolean | null;
  problem?: string | null;
};

const percent = (weight: number, of = 1) =>
  `${((weight / CREATOR_BOX_WEIGHT_TOTAL / of) * 100).toFixed(2)}%`;
const buzz = (amount: number) => `${numberWithCommas(amount)} Buzz`;

/**
 * A creator mystery pack as a moderator judges it: the edit waiting (or, with none, the live
 * version), its odds, its value against its price, and what it changes from live.
 */
export function MysteryPackReviewPanel({ review }: { review: MysteryPackReview }) {
  const { proposed, live, diff, revision } = review;
  const cosmetics = new Map(review.cosmetics.map((c) => [c.id, c]));
  const sales = new Map(review.shelfSales.map((s) => [s.cosmeticId, s.sales]));

  const shown: { tiers: Tier[]; contents: Content[]; price: number; bounds: Bounds | null } | null =
    proposed
      ? {
          tiers: proposed.tiers,
          contents: proposed.contents,
          price: proposed.price,
          bounds: proposed.bounds,
        }
      : live
      ? {
          tiers: live.tiers.map((t) => ({
            ...t,
            count: live.contents.filter((c) => c.tier === t.key).length,
          })),
          contents: live.contents.map((c) => ({ ...c, value: c.value ?? null })),
          price: live.price,
          bounds: live.bounds,
        }
      : null;
  if (!shown)
    return <Alert color="yellow">This mystery pack has no edit and no live version.</Alert>;

  const tierName = new Map(shown.tiers.map((t) => [t.key, t.name]));
  const nameOf = (id: number) => cosmetics.get(id)?.name ?? `Item #${id}`;
  const problems = shown.contents.filter((c) => c.problem);

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {revision
          ? `Edit submitted ${daysFromNow(revision.createdAt)}${
              live ? `, against live version ${revision.baseVersion}` : ' (first submission)'
            }.`
          : `No edit waiting. Showing live version ${live?.version}.`}
      </Text>

      {revision && revision.baseVersion !== review.version && (
        <Alert color="yellow">
          The pack has changed since this edit was made (version {revision.baseVersion}, now{' '}
          {review.version}). Approving it closes the edit as out of date, and the creator has to
          edit again.
        </Alert>
      )}
      {proposed?.layoutProblem && <Alert color="red">{proposed.layoutProblem}</Alert>}
      {proposed?.priceProblem && <Alert color="red">{proposed.priceProblem}</Alert>}
      {!!problems.length && (
        <Alert color="red">
          {problems.length === 1
            ? '1 item no longer qualifies'
            : `${problems.length} items no longer qualify`}
          , so approval will be refused until the creator edits the pack.
        </Alert>
      )}

      <ValueTiles price={shown.price} bounds={shown.bounds} />

      <Stack gap={6}>
        <Text size="sm" fw={600}>
          Tiers
        </Text>
        <Paper withBorder radius="md">
          {shown.tiers.map((tier, i) => (
            <Group
              key={tier.key}
              justify="space-between"
              wrap="nowrap"
              px="md"
              py={8}
              className={
                i < shown.tiers.length - 1 ? 'border-b border-gray-3 dark:border-dark-4' : undefined
              }
            >
              <Text size="sm" fw={600}>
                {tier.name}
                <Text span size="xs" c="dimmed" fw={400}>
                  {' '}
                  · {tier.count} item{tier.count === 1 ? '' : 's'}
                </Text>
              </Text>
              <Text size="sm" ta="right">
                {tier.weight === null ? (
                  '—'
                ) : (
                  <>
                    {percent(tier.weight)}
                    <Text span size="xs" c="dimmed">
                      {' '}
                      · {percent(tier.weight, tier.count)} each
                    </Text>
                  </>
                )}
              </Text>
            </Group>
          ))}
        </Paper>
      </Stack>

      <Stack gap={6}>
        <Text size="sm" fw={600}>
          Contents ({shown.contents.length})
        </Text>
        {shown.tiers.map((tier) => (
          <Stack key={tier.key} gap={4}>
            <Text size="xs" fw={600} c="dimmed" tt="uppercase">
              {tier.name}
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing={6}>
              {shown.contents
                .filter((c) => c.tier === tier.key)
                .map((content) => {
                  const cosmetic = cosmetics.get(content.cosmeticId);
                  const soldCount = sales.get(content.cosmeticId);
                  return (
                    <Paper key={content.cosmeticId} withBorder radius="md" p="xs">
                      <Group gap="xs" wrap="nowrap" align="center">
                        <CosmeticThumb
                          data={cosmetic?.data}
                          name={cosmetic?.name ?? String(content.cosmeticId)}
                        />
                        <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                          <Text size="sm" fw={600} lineClamp={1}>
                            {nameOf(content.cosmeticId)}
                          </Text>
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {cosmetic ? getDisplayName(cosmetic.type) : 'Unknown item'}
                          </Text>
                          {content.problem && (
                            <Text size="xs" c="red">
                              {content.problem}
                            </Text>
                          )}
                        </Stack>
                        <Stack gap={2} align="flex-end">
                          {content.value !== null && (
                            <Text size="xs" fw={600}>
                              {buzz(content.value)}
                            </Text>
                          )}
                          {content.listed === false && (
                            <Badge size="xs" color="gray" variant="light">
                              Box-only
                            </Badge>
                          )}
                          {soldCount !== undefined && (
                            <Badge size="xs" color={soldCount ? 'teal' : 'orange'} variant="light">
                              {numberWithCommas(soldCount)} shelf sale{soldCount === 1 ? '' : 's'}
                            </Badge>
                          )}
                        </Stack>
                      </Group>
                    </Paper>
                  );
                })}
            </SimpleGrid>
          </Stack>
        ))}
        <Text size="xs" c="dimmed">
          Each item counts at its shelf price, and a box-only item at its type&apos;s price floor.
          Shelf sales are shown for anything valued over{' '}
          {numberWithCommas(SHELF_SALES_VALUE_THRESHOLD)}.
        </Text>
      </Stack>

      {diff && live && (
        <Stack gap={6}>
          <Text size="sm" fw={600}>
            Changes from live version {live.version}
          </Text>
          <Paper withBorder radius="md" p="sm">
            {!diff.added.length &&
            !diff.removed.length &&
            !diff.moved.length &&
            !diff.tiers.length &&
            !diff.price ? (
              <Text size="sm" c="dimmed">
                No changes to the contents, odds or price.
              </Text>
            ) : (
              <Stack gap={4}>
                {diff.price && (
                  <Text size="sm">
                    Price {buzz(diff.price.before)} → {buzz(diff.price.after)}
                  </Text>
                )}
                {diff.tiers.map((t) => (
                  <Text key={t.key} size="sm">
                    {t.name} odds {t.before === null ? 'new' : percent(t.before)} →{' '}
                    {t.after === null ? 'removed' : percent(t.after)}
                  </Text>
                ))}
                {diff.added.map((c) => (
                  <Text key={`a${c.cosmeticId}`} size="sm" c="green">
                    + {nameOf(c.cosmeticId)} in {tierName.get(c.tier) ?? c.tier}
                  </Text>
                ))}
                {diff.removed.map((c) => (
                  <Text key={`r${c.cosmeticId}`} size="sm" c="red">
                    − {nameOf(c.cosmeticId)} from{' '}
                    {live.tiers.find((t) => t.key === c.tier)?.name ?? c.tier}
                  </Text>
                ))}
                {diff.moved.map((c) => (
                  <Text key={`m${c.cosmeticId}`} size="sm">
                    {nameOf(c.cosmeticId)}:{' '}
                    {live.tiers.find((t) => t.key === c.from)?.name ?? c.from} →{' '}
                    {tierName.get(c.to) ?? c.to}
                  </Text>
                ))}
              </Stack>
            )}
          </Paper>
        </Stack>
      )}
    </Stack>
  );
}

function ValueTiles({ price, bounds }: { price: number; bounds: Bounds | null }) {
  const cap = bounds ? CREATOR_BOX_WORST_DRAW_MULTIPLE * bounds.worst : null;
  const tiles = [
    { label: 'Price', value: buzz(price), bad: false },
    {
      label: 'Average box gives back',
      value: bounds ? buzz(bounds.average) : '—',
      bad: !!bounds && price > bounds.average,
    },
    {
      label: `Worst draw (price ≤ ${CREATOR_BOX_WORST_DRAW_MULTIPLE}×)`,
      value: bounds ? `${buzz(bounds.worst)} · cap ${numberWithCommas(cap!)}` : '—',
      bad: !!cap && price > cap,
    },
    {
      label: 'Allowed price',
      value: bounds
        ? bounds.max < bounds.min
          ? 'None'
          : `${numberWithCommas(bounds.min)} to ${numberWithCommas(bounds.max)}`
        : '—',
      bad: !!bounds && (bounds.max < bounds.min || price < bounds.min || price > bounds.max),
    },
  ];
  return (
    <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="sm">
      {tiles.map((tile) => (
        <Paper key={tile.label} withBorder radius="md" px="sm" py={8}>
          <Text size="xs" c="dimmed">
            {tile.label}
          </Text>
          <Text size="sm" fw={600} c={tile.bad ? 'red' : undefined}>
            {tile.value}
          </Text>
        </Paper>
      ))}
    </SimpleGrid>
  );
}
