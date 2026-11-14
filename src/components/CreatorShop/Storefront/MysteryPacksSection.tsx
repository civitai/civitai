import { Stack } from '@mantine/core';
import { sectionIcons, storefrontSectionId } from '~/components/CreatorShop/section-meta';
import { SectionHeader } from '~/components/CreatorShop/Storefront/SectionHeader';
import { MysteryBoxCard } from '~/components/MysteryBox/MysteryBoxCard';
import { MysteryBoxCatalogCard } from '~/components/MysteryBox/MysteryBoxCatalogCard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { creatorMysteryPacksEnabled } from '~/server/schema/creator-shop.schema';
import { trpc } from '~/utils/trpc';

const PACK_COLOR = 'var(--mantine-color-violet-5)';

export function MysteryPacksSection({ ownerUserId }: { ownerUserId: number }) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const enabled = creatorMysteryPacksEnabled(features) && ownerUserId > 0;
  const views = trpc.mysteryBox.getForSeller.useQuery(
    { sellerId: ownerUserId },
    { enabled: enabled && !!currentUser }
  );
  const catalog = trpc.mysteryBox.getForCreator.useQuery(
    { sellerId: ownerUserId },
    { enabled: enabled && !currentUser }
  );

  const cards = currentUser
    ? (views.data ?? []).map((view) => (
        <MysteryBoxCard
          key={view.boxDefinitionId}
          source={{ seller: ownerUserId }}
          view={view}
          color={PACK_COLOR}
        />
      ))
    : (catalog.data ?? []).map((box) => (
        <MysteryBoxCatalogCard key={box.boxDefinitionId} box={box} />
      ));
  if (!enabled || !cards.length) return null;

  return (
    <Stack gap="md" id={storefrontSectionId('mysteryPacks')} data-testid="mystery-packs-section">
      <SectionHeader icon={sectionIcons.mysteryPacks} title="Mystery packs" />
      {cards}
    </Stack>
  );
}
