import { useMemo } from 'react';
import { HomeBlockHeaderMeta } from '~/components/HomeBlocks/components/HomeBlockHeaderMeta';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { ShopItem } from '~/components/Shop/ShopItem';
import { ShopSection } from '~/components/Shop/ShopSection';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { trpc } from '~/utils/trpc';

export function CosmeticShopSectionHomeBlock({ showAds, ...props }: Props) {
  const features = useFeatureFlags();

  if (!props.metadata.cosmeticShopSection) return null;

  if (!features.cosmeticShopHomeBlock) {
    return null;
  }

  return (
    <HomeBlockWrapper py={32} showAds={showAds}>
      <CosmeticShopSectionHomeBlockContent {...props} />
    </HomeBlockWrapper>
  );
}

function CosmeticShopSectionHomeBlockContent({ metadata, homeBlockId }: Props) {
  const { data: homeBlock, isLoading } = trpc.homeBlock.getHomeBlock.useQuery(
    { id: homeBlockId },
    { trpc: { context: { skipBatch: true } } }
  );

  const cosmeticShopSection = homeBlock?.cosmeticShopSection;

  const items = useMemo(() => {
    if (!cosmeticShopSection) return [];

    if (metadata.cosmeticShopSection?.maxItems) {
      return cosmeticShopSection.items.slice(0, metadata.cosmeticShopSection.maxItems);
    }

    return cosmeticShopSection.items;
  }, [cosmeticShopSection, metadata]);

  if (!cosmeticShopSection) {
    return null;
  }

  // How we can go to town:
  return (
    <>
      <HomeBlockHeaderMeta
        metadata={{
          ...metadata,
          title: metadata?.title ?? cosmeticShopSection.title,
          description: metadata?.description ?? cosmeticShopSection.description ?? '',
        }}
        htmlMode
      />
      <ShopSection.Items>
        {items.map((item) => {
          const { shopItem } = item;
          return (
            <ShopItem key={shopItem.id} item={shopItem} sectionItemCreatedAt={item.createdAt} />
          );
        })}
      </ShopSection.Items>
    </>
  );
}

type Props = { metadata: HomeBlockMetaSchema; showAds?: boolean; homeBlockId: number };
