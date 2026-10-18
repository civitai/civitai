import { Group, Progress, Text } from '@mantine/core';
import type { OddsContent, TierSummary } from '~/components/MysteryBox/mystery-box.utils';
import { formatChance, tierColor } from '~/components/MysteryBox/mystery-box.utils';

/** The viewer's tier odds as one bar, commonest first, with a legend. */
export function MysteryBoxOddsBar({
  tiers,
  legend = true,
}: {
  /** Rarest first, as `tierSummaries` returns them. */
  tiers: TierSummary<OddsContent>[];
  legend?: boolean;
}) {
  const commonestFirst = [...tiers].reverse();
  return (
    <div>
      <Progress.Root size={10} radius="xl" data-testid="box-odds-bar">
        {commonestFirst.map(
          (t) =>
            t.probability > 0 && (
              <Progress.Section
                key={t.tier.id}
                value={t.probability * 100}
                color={tierColor(t.tier)}
                aria-label={`${t.tier.name} ${formatChance(t.probability, 0)}`}
              />
            )
        )}
      </Progress.Root>
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
