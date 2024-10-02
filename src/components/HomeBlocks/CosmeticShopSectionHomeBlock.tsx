import { Grid } from '@mantine/core';
import { useMemo } from 'react';
import { HomeBlockHeaderMeta } from '~/components/HomeBlocks/components/HomeBlockHeaderMeta';
import { useHomeBlockGridStyles } from '~/components/HomeBlocks/HomeBlock.Styles';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { ShopItem } from '~/components/Shop/ShopItem';
import { ShopSection } from '~/components/Shop/ShopSection';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { trpc } from '~/utils/trpc';

export function CosmeticShopSectionHomeBlock({ showAds, ...props }: Props) {

  if (!props.metadata.cosmeticShopSection) return null;

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

  const { classes, cx } = useHomeBlockGridStyles({
    count: items.length ?? 0,
    rows: 2,
  });

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
        <div className={cx(classes.grid, `mt-2 py-2`)}>
          {items.map((item) => {
            const { shopItem } = item;
            return (
              <div>
                <ShopItem key={shopItem.id} item={shopItem} sectionItemCreatedAt={item.createdAt} hideNew />
              </div>
            );
          })}
      </div>
    </>
  );
}

type Props = { metadata: HomeBlockMetaSchema; showAds?: boolean; homeBlockId: number };
