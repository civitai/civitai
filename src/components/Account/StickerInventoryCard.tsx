import { Badge, Card, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useOwnedSticker } from '~/components/Sticker/sticker.util';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { stickerSurfaceLabels, STICKER_SIZE } from '~/shared/utils/sticker-token';
import { trpc } from '~/utils/trpc';

const { charged, free } = stickerSurfaceLabels();

export function StickerInventoryCard() {
  const features = useFeatureFlags();
  const { sticker, isLoading } = useOwnedSticker();
  const { data: balanceRows } = trpc.cosmetic.getStickerBalances.useQuery(undefined, {
    enabled: features.stickers,
  });

  if (!features.stickers) return null;

  // null remaining = unlimited; a missing row means the balance hasn't loaded.
  const balances = new Map((balanceRows ?? []).map((b) => [b.cosmeticId, b.remaining]));

  return (
    <Card withBorder id="stickers">
      <Stack>
        <Title order={2}>Stickers</Title>
        <Text size="sm" c="dimmed">
          Stickers you own. A use is spent each time you place one in {charged.join(', ')}; using
          them in {free.join(', ')} is free.
        </Text>

        {isLoading ? (
          <Group justify="center" p="md">
            <Loader size="sm" />
          </Group>
        ) : !sticker.length ? (
          <Text size="sm" c="dimmed">
            You don&apos;t own any stickers yet. Find some in the{' '}
            <Text component={Link} href="/shop" c="blue.4" inherit>
              shop
            </Text>
            .
          </Text>
        ) : (
          <Stack gap={4}>
            {sticker.map((item) => {
              const remaining = balances.get(item.id);
              // Exhausted stays listed and dimmed: hiding it reads as the sticker
              // having been taken away rather than used up.
              const exhausted = remaining === 0;
              return (
                <Group
                  key={item.id}
                  justify="space-between"
                  wrap="nowrap"
                  className={exhausted ? 'opacity-50' : undefined}
                >
                  <Group gap="sm" wrap="nowrap">
                    <EdgeImage
                      src={item.url}
                      alt={`:${item.slug}:`}
                      options={{ height: STICKER_SIZE.jumbo, anim: item.animated, optimized: true }}
                      style={{
                        height: STICKER_SIZE.inline,
                        width: 'auto',
                        objectFit: 'contain',
                      }}
                    />
                    <Stack gap={0}>
                      <Text size="sm" fw={500} lineClamp={1}>
                        {item.name}
                      </Text>
                      <Text size="xs" c="dimmed">
                        :{item.slug}:
                      </Text>
                    </Stack>
                  </Group>
                  {exhausted ? (
                    <Text component={Link} href="/shop" size="xs" c="blue.4">
                      Buy more
                    </Text>
                  ) : (
                    <Badge variant="light" color={remaining == null ? 'green' : 'gray'}>
                      {remaining == null ? 'Unlimited' : `${remaining} left`}
                    </Badge>
                  )}
                </Group>
              );
            })}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
