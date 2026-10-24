import { Badge, Group, Loader, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconFingerprint } from '@tabler/icons-react';
import { ChecksCard } from '~/components/CreatorShop/ChecksCard';
import { CREATOR_SHOP_BORDER } from '~/components/CreatorShop/creator-shop.constants';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type {
  CosmeticSimilarityResult,
  SimilarCosmetic,
} from '~/server/services/cosmetic-phash.service';
import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';

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
  'no-corpus':
    'No other cosmetic currently has a comparable fingerprint, so there was nothing to compare against. This is expected for a while after a fingerprint upgrade, until the sweep has re-done the library.',
} as const;

// `null` means the cosmetic was never listed in a shop — every official cosmetic
// looks like this, and it is not the same as a listing that exists and is not live.
function shopStatusLabel(status: SimilarCosmetic['shopStatus']) {
  if (!status) return 'not listed';
  return status === CosmeticShopItemStatus.PendingReview
    ? 'pending review'
    : status === CosmeticShopItemStatus.RequestedChanges
    ? 'changes requested'
    : status.toLowerCase();
}

function shopStatusColor(status: SimilarCosmetic['shopStatus']) {
  if (status === CosmeticShopItemStatus.Published) return 'green';
  if (!status) return 'gray';
  return 'yellow';
}

export function SimilarArtworkCard({
  result,
  isLoading,
  isError,
}: {
  result: CosmeticSimilarityResult | undefined;
  isLoading: boolean;
  isError?: boolean;
}) {
  return (
    <ChecksCard
      icon={<IconFingerprint size={15} color="var(--mantine-color-dimmed)" />}
      title="Similar artwork"
    >
      {/* A lookup that errored must not keep spinning. A permanent spinner and a
          slow one look the same, and "still working" reads as "no problem" —
          which is the ambiguity this whole card exists to remove. */}
      {isError ? (
        <Group gap={9} px="md" py={9} align="flex-start" wrap="nowrap">
          <IconAlertTriangle
            size={16}
            color="var(--mantine-color-red-5)"
            style={{ flexShrink: 0, marginTop: 2 }}
          />
          <Text size="sm" c="dimmed">
            The similarity check failed to run, so this artwork was not compared against anything.
            Reload to try again.
          </Text>
        </Group>
      ) : isLoading || !result ? (
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
          {/* Not "the N closest" any more. The list is a threshold, not a rank —
              anything too far away is dropped rather than padding it out, so a
              short list means few were close and not that few were compared. */}
          <Text size="xs" c="dimmed" px="md" pt={9} pb={4}>
            {result.matches.length} of {result.comparedAgainst.toLocaleString()} cosmetics{' '}
            {result.matches.length === 1 ? 'was' : 'were'} close enough to be worth a look, most
            alike first. Closeness is a prompt to look, not a verdict.
          </Text>
          <Stack gap={0}>
            {result.matches.map((match) => {
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
                    <Group gap={6} wrap="nowrap">
                      <Text size="xs" c="dimmed" lineClamp={1}>
                        {match.createdByUsername
                          ? `@${match.createdByUsername}`
                          : 'Official Civitai cosmetic'}
                      </Text>
                      {/* Whether the match is actually on sale changes what the
                          resemblance means — a look-alike of something already
                          rejected is a different decision from one of a live
                          listing, and both look identical without this. */}
                      <Badge size="xs" variant="light" color={shopStatusColor(match.shopStatus)}>
                        {shopStatusLabel(match.shopStatus)}
                      </Badge>
                    </Group>
                  </Stack>
                  <Badge
                    size="sm"
                    variant={match.close ? 'filled' : 'light'}
                    color={match.close ? 'red' : 'gray'}
                  >
                    {match.close ? 'near-identical' : `${match.distance}/${match.bits}`}
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
