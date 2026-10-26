import clsx from 'clsx';
import { useMemo } from 'react';
import { HomeBlockHeaderMeta } from '~/components/HomeBlocks/components/HomeBlockHeaderMeta';
import classes from '~/components/HomeBlocks/HomeBlock.module.scss';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { ShopItem } from '~/components/Shop/ShopItem';
import { CIVITAI_SHOP_ATTRIBUTION } from '~/server/schema/cosmetic-shop.schema';
import { useHiddenPreferencesContext } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import {
  SHOP_BLOCK_ROWS,
  shopBlockMaxItems,
  visibleShopBlockItems,
} from '~/shared/utils/cosmetic-shop-rotation';
import { trpc } from '~/utils/trpc';

export function CosmeticShopSectionHomeBlock({ showAds, ...props }: Props) {
  if (!props.metadata.cosmeticShopSection) return null;

  return (
    <HomeBlockWrapper py={32}>
      <CosmeticShopSectionHomeBlockContent {...props} />
    </HomeBlockWrapper>
  );
}

function CosmeticShopSectionHomeBlockContent({ metadata, homeBlockId }: Props) {
  const { data: homeBlock, isLoading } = trpc.homeBlock.getHomeBlock.useQuery(
    { id: homeBlockId },
    { trpc: { context: { skipBatch: true } } }
  );

  const { blockRelations, hiddenLoading } = useHiddenPreferencesContext();
  const cosmeticShopSection = homeBlock?.cosmeticShopSection;

  const items = useMemo(() => {
    if (!cosmeticShopSection) return [];
    // The server sends more than the row, rotated when the block rotates, so a viewer who blocks
    // a seller still gets a full row from the items behind it.
    return visibleShopBlockItems(cosmeticShopSection.items, {
      blockRelations,
      maxItems: shopBlockMaxItems(metadata.cosmeticShopSection),
    });
  }, [cosmeticShopSection, metadata, blockRelations]);

  // Blocks are applied here and nowhere else, so nothing renders until they are known.
  if (!cosmeticShopSection || hiddenLoading) {
    return null;
  }

  // How we can go to town:
  return (
    <div
      style={
        {
          '--count': items.length ?? 0,
          '--rows': SHOP_BLOCK_ROWS,
        } as React.CSSProperties
      }
    >
      <HomeBlockHeaderMeta
        metadata={{
          ...metadata,
          title: metadata?.title ?? cosmeticShopSection.title,
          description: metadata?.description ?? cosmeticShopSection.description ?? '',
        }}
        htmlMode
      />
      <div className={clsx(classes.grid, classes.gridRow, `mt-2 py-2`)}>
        {items.map((item) => {
          const { shopItem } = item;
          return (
            <div key={shopItem.id} className="p-2">
              <ShopItem
                item={shopItem}
                sectionItemCreatedAt={item.createdAt}
                creator={shopItem.cosmetic?.creator ?? shopItem.addedBy}
                viaShopUserId={CIVITAI_SHOP_ATTRIBUTION}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

type Props = { metadata: HomeBlockMetaSchema; showAds?: boolean; homeBlockId: number };
