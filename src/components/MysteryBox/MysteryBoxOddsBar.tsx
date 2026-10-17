import { Group, Text } from '@mantine/core';
import type { TierSummary } from '~/components/MysteryBox/mystery-box.utils';
import { formatChance, tierColor } from '~/components/MysteryBox/mystery-box.utils';

/** The viewer's tier odds as one bar, commonest first, with a legend. */
export function MysteryBoxOddsBar({
  tiers,
  legend = true,
}: {
  /** Rarest first, as `tierSummaries` returns them. */
  tiers: TierSummary[];
  legend?: boolean;
}) {
  const commonestFirst = [...tiers].reverse();
  return (
    <div>
      <div
        className="flex h-2.5 overflow-hidden rounded-full bg-gray-2 dark:bg-dark-4"
        role="img"
        aria-label={commonestFirst
          .map((t) => `${t.tier.name} ${formatChance(t.probability, 0)}`)
          .join(', ')}
        data-testid="box-odds-bar"
      >
        {commonestFirst.map(
          (t) =>
            t.probability > 0 && (
              <span
                key={t.tier.id}
                className="h-full"
                style={{ width: `${t.probability * 100}%`, background: tierColor(t.tier) }}
              />
            )
        )}
      </div>
      {legend && (
        <Group gap="sm" mt={6}>
          {commonestFirst.map((t) => (
            <Group key={t.tier.id} gap={4} wrap="nowrap">
              <span
                className="inline-block size-2 rounded-full"
                style={{ background: tierColor(t.tier) }}
              />
              <Text size="xs" c={t.probability > 0 ? undefined : 'dimmed'}>
                {t.tier.name} {t.left ? formatChance(t.probability, 0) : 'complete'}
              </Text>
            </Group>
          ))}
        </Group>
      )}
    </div>
  );
}
