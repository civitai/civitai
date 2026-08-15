import { Badge, Group, Loader, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconFingerprint } from '@tabler/icons-react';
import { ChecksCard } from '~/components/CreatorShop/ChecksCard';
import { CREATOR_SHOP_BORDER } from '~/components/CreatorShop/creator-shop.constants';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { COSMETIC_SIMILARITY_CLOSE_RATIO } from '~/shared/constants/cosmetic-shop.constants';
import type { CosmeticSimilarityResult } from '~/server/services/cosmetic-phash.service';

// Why a mod is being shown nothing, in the mod's terms. A blank panel cannot say
// which of these it means, and "we checked and found nothing" is a very different
// instruction from "this was never checked".
const UNAVAILABLE_COPY = {
  'no-hash':
    'This artwork has not been fingerprinted yet, so nothing was compared. It is picked up automatically within about 15 minutes.',
  'stale-hash':
    'The artwork changed after it was fingerprinted, so the stored fingerprint describes an older image. Nothing was compared.',
  'flat-artwork':
    'This artwork is almost entirely transparent or one flat colour, which every such image fingerprints identically. Comparing it would return unrelated cosmetics, so nothing was compared.',
} as const;

export function SimilarArtworkCard({
  result,
  isLoading,
}: {
  result: CosmeticSimilarityResult | undefined;
  isLoading: boolean;
}) {
  return (
    <ChecksCard
      icon={<IconFingerprint size={15} color="var(--mantine-color-dimmed)" />}
      title="Similar artwork"
    >
      {isLoading || !result ? (
        <Group gap={9} px="md" py={9} align="center">
          <Loader size={16} />
          <Text size="sm" c="dimmed">
            Comparing against every fingerprinted cosmetic…
          </Text>
        </Group>
      ) : result.status === 'unavailable' ? (
        <Group gap={9} px="md" py={9} align="flex-start" wrap="nowrap">
          <IconAlertTriangle
            size={16}
            color="var(--mantine-color-yellow-5)"
            style={{ flexShrink: 0, marginTop: 2 }}
          />
          <Text size="sm" c="dimmed">
            {UNAVAILABLE_COPY[result.reason]}
          </Text>
        </Group>
      ) : !result.matches.length ? (
        <Group gap={9} px="md" py={9} align="center" wrap="nowrap">
          <IconCircleCheck size={16} color="var(--mantine-color-green-5)" />
          <Text size="sm" c="dimmed">
            No similar artwork found — compared against {result.comparedAgainst.toLocaleString()}{' '}
            cosmetics.
          </Text>
        </Group>
      ) : (
        <>
          <Text size="xs" c="dimmed" px="md" pt={9} pb={4}>
            The {result.matches.length} closest of {result.comparedAgainst.toLocaleString()}{' '}
            cosmetics, most alike first. Closeness is a prompt to look, not a verdict.
          </Text>
          <Stack gap={0}>
            {result.matches.map((match) => {
              const close = match.distance <= match.bits * COSMETIC_SIMILARITY_CLOSE_RATIO;
              return (
                <Group
                  key={match.id}
                  gap={10}
                  px="md"
                  py={8}
                  wrap="nowrap"
                  align="center"
                  style={{ borderTop: CREATOR_SHOP_BORDER }}
                >
                  <div
                    className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded"
                    style={{ background: 'var(--mantine-color-default-hover)' }}
                  >
                    {match.url ? (
                      <EdgeMedia src={match.url} width={80} type="image" alt={match.name} />
                    ) : null}
                  </div>
                  <Stack gap={0} className="min-w-0" style={{ flex: 1 }}>
                    <Text size="sm" fw={500} lineClamp={1}>
                      {match.name}
                    </Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {match.createdByUsername
                        ? `@${match.createdByUsername}`
                        : 'Official Civitai cosmetic'}
                    </Text>
                  </Stack>
                  <Badge
                    size="sm"
                    variant={close ? 'filled' : 'light'}
                    color={close ? 'red' : 'gray'}
                  >
                    {close ? 'near-identical' : `${match.distance}/${match.bits}`}
                  </Badge>
                </Group>
              );
            })}
          </Stack>
        </>
      )}
    </ChecksCard>
  );
}
