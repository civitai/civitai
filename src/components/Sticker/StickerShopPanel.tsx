import {
  Button,
  CloseButton,
  HoverCard,
  Loader,
  ScrollArea,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useMutateCosmeticShop, useQueryShop } from '~/components/CosmeticShop/cosmetic-shop.util';
import { useQueryCommunityCosmetics } from '~/components/CreatorShop/creator-shop.util';
import { useOwnedCosmeticIds } from '~/components/CreatorShop/Storefront/storefront.util';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { browseShopItems } from '~/components/Shop/shop-browse';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import { stickerPurchaseTerms } from '~/components/Sticker/sticker.util';
import { CosmeticShopSort } from '~/server/common/enums';
import type { StickerCosmetic } from '~/server/selectors/cosmetic.selector';
import { CIVITAI_SHOP_ATTRIBUTION } from '~/server/schema/cosmetic-shop.schema';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { numberWithCommas } from '~/utils/number-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';

/** The single page of the community catalog this panel holds client-side. */
const COMMUNITY_PAGE_SIZE = 100;

type Tile = {
  shopItemId: number;
  cosmeticId: number;
  title: string;
  unitAmount: number;
  data: StickerCosmetic['data'];
  cosmeticData: unknown;
  viaShopUserId?: number;
  owned: boolean;
};

/**
 * The shop, inside the placement tray. Same reason the top-up lives here: a tray
 * you have to leave to buy from is a placement you don't make.
 *
 * Two sources, one shelf. Official stickers come from the sectioned shop and
 * creator-made ones from the community hub — separate endpoints because they are
 * separate catalogs, but a shopper looking for a sticker does not care which
 * shelf it came off, so they are merged and sorted together here.
 */
export function StickerShopPanel({
  onClose,
  onTopUp,
}: {
  onClose: () => void;
  /** Owned stickers can't be bought again; more uses is the only thing left to sell. */
  onTopUp: (sticker: ResolvedSticker) => void;
}) {
  const [search, setSearch] = useState('');
  const [showOwned, setShowOwned] = useState(false);

  const ownedCosmeticIds = useOwnedCosmeticIds();
  const { cosmeticShopSections, isLoading: loadingOfficial } = useQueryShop({
    cosmeticTypes: [CosmeticType.Sticker],
  });
  const {
    items: communityItems,
    totalPages,
    isLoading: loadingCommunity,
  } = useQueryCommunityCosmetics({
    cosmeticTypes: [CosmeticType.Sticker],
    sort: CosmeticShopSort.MostPopular,
    limit: COMMUNITY_PAGE_SIZE,
    page: 1,
    owned: showOwned ? undefined : 'notOwned',
  });
  const { purchaseShopItem, purchasingShopItem } = useMutateCosmeticShop();

  const isLoading = loadingOfficial || loadingCommunity;

  const tiles = useMemo(() => {
    // Most-sold first, matching the order the community half is already asking
    // the server for, so the merged shelf has one order rather than two.
    const official = browseShopItems({
      entries: (cosmeticShopSections ?? []).flatMap((section) => section.items),
      shopItemOf: (entry) => entry.shopItem,
      listedAtOf: (entry) => entry.createdAt,
      filters: {
        cosmeticTypes: [CosmeticType.Sticker],
        ...(showOwned ? {} : { modifier: 'notOwned' as const }),
      },
      sort: CosmeticShopSort.MostPopular,
      ownedCosmeticIds,
      wishlistedIds: new Set<number>(),
    }).map(({ shopItem }) => ({
      shopItemId: shopItem.id,
      cosmeticId: shopItem.cosmeticId,
      title: shopItem.title,
      unitAmount: shopItem.unitAmount,
      cosmeticData: shopItem.cosmetic?.data,
      viaShopUserId: CIVITAI_SHOP_ATTRIBUTION,
    }));

    const community = communityItems.map((item) => ({
      shopItemId: item.id,
      cosmeticId: item.cosmeticId,
      title: item.title,
      unitAmount: item.unitAmount,
      cosmeticData: item.cosmetic?.data,
      // Attributes the sale to the shop it was bought from, the same way the
      // storefront grid does.
      viaShopUserId: item.addedById ?? undefined,
    }));

    const seen = new Set<number>();
    const query = search.trim().toLowerCase();

    return [...official, ...community].reduce<Tile[]>((acc, entry) => {
      if (entry.cosmeticId == null || seen.has(entry.shopItemId)) return acc;
      const data = entry.cosmeticData as StickerCosmetic['data'] | undefined;
      if (!data?.url) return acc;
      if (query && !`${entry.title} ${data.slug ?? ''}`.toLowerCase().includes(query)) return acc;

      seen.add(entry.shopItemId);
      acc.push({
        shopItemId: entry.shopItemId,
        cosmeticId: entry.cosmeticId,
        title: entry.title,
        unitAmount: entry.unitAmount,
        data,
        cosmeticData: entry.cosmeticData,
        viaShopUserId: entry.viaShopUserId,
        owned: ownedCosmeticIds.has(entry.cosmeticId),
      });
      return acc;
    }, []);
  }, [cosmeticShopSections, communityItems, ownedCosmeticIds, search, showOwned]);

  const buy = async (tile: Tile) => {
    try {
      await purchaseShopItem({ shopItemId: tile.shopItemId, viaShopUserId: tile.viaShopUserId });
      showSuccessNotification({
        title: 'Sticker purchased',
        message: `${tile.title} is in your stickers below.`,
      });
    } catch (error) {
      showErrorNotification({
        title: 'Could not buy that sticker',
        error: error instanceof Error ? error : new Error('Purchase failed'),
      });
    }
  };

  return (
    <div className="mb-2 w-full overflow-hidden rounded-lg border border-gray-3 bg-white shadow-lg dark:border-dark-4 dark:bg-dark-7">
      <div className="flex items-center gap-2 border-b border-gray-3 px-3 py-2 dark:border-dark-4">
        <TextInput
          size="xs"
          className="flex-1"
          placeholder="Search stickers"
          leftSection={<IconSearch size={14} />}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          aria-label="Search stickers"
        />
        <Switch
          size="xs"
          label="Owned"
          checked={showOwned}
          onChange={(event) => setShowOwned(event.currentTarget.checked)}
        />
        <CloseButton onClick={onClose} aria-label="Close the sticker shop" />
      </div>

      <ScrollArea.Autosize mah={260} type="auto" scrollbarSize={6}>
        <div className="flex flex-wrap gap-2 p-2">
          {isLoading && (
            <div className="flex w-full items-center gap-2 p-2">
              <Loader size="xs" />
              <Text size="sm">Loading the shop…</Text>
            </div>
          )}
          {!isLoading && !tiles.length && (
            <Text size="sm" c="dimmed" p="xs">
              {search
                ? `Nothing matches “${search}”.`
                : showOwned
                ? 'No stickers on sale right now.'
                : 'Nothing new here — you already own every sticker on sale.'}
            </Text>
          )}

          {tiles.map((tile) => {
            const terms = stickerPurchaseTerms(tile.cosmeticData);

            return (
              <HoverCard
                key={tile.shopItemId}
                width={220}
                withArrow
                openDelay={200}
                position="top"
                shadow="sm"
              >
                <HoverCard.Target>
                  <div className="flex w-24 shrink-0 flex-col items-center gap-1 rounded border border-transparent p-1">
                    <EdgeImage
                      src={tile.data.url}
                      alt={tile.data.slug ? `:${tile.data.slug}:` : tile.title}
                      options={{ height: 96, anim: tile.data.animated, optimized: true }}
                      style={{ height: 48, width: 'auto' }}
                    />
                    <Text size="10px" lineClamp={1} ta="center" className="w-full">
                      {tile.title}
                    </Text>
                    <Text size="10px" c="dimmed" lineClamp={1}>
                      {terms.usesLabel}
                    </Text>
                    {tile.owned ? (
                      // Owning it is terminal — the shop can't sell it twice, so
                      // the only thing left to buy is more uses of it.
                      <Button
                        size="compact-xs"
                        variant="light"
                        className="w-full"
                        onClick={() =>
                          onTopUp({
                            id: tile.cosmeticId,
                            name: tile.title,
                            slug: tile.data.slug ?? tile.title,
                            url: tile.data.url,
                            animated: tile.data.animated,
                            pricePerUse: tile.data.pricePerUse,
                          })
                        }
                      >
                        Buy uses
                      </Button>
                    ) : (
                      <BuzzTransactionButton
                        size="compact-xs"
                        className="w-full"
                        buzzAmount={tile.unitAmount}
                        label=""
                        loading={purchasingShopItem}
                        onPerformTransaction={() => buy(tile)}
                      />
                    )}
                  </div>
                </HoverCard.Target>
                <HoverCard.Dropdown p="xs">
                  <Text size="sm" fw={600} lineClamp={2}>
                    {tile.title}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {numberWithCommas(tile.unitAmount)} Buzz · {terms.usesLabel}
                  </Text>
                  {terms.extraUseLabel && (
                    <Text size="xs" c="dimmed">
                      {terms.extraUseLabel}
                    </Text>
                  )}
                </HoverCard.Dropdown>
              </HoverCard>
            );
          })}
        </div>

        {/* Says so rather than truncating quietly: search filters what is loaded,
            so a shopper past this line needs to know the shelf is not all of it. */}
        {totalPages > 1 && (
          <Text size="10px" c="dimmed" px="xs" pb="xs">
            Showing the {COMMUNITY_PAGE_SIZE} best-selling community stickers. Browse the full shop
            for the rest.
          </Text>
        )}
      </ScrollArea.Autosize>
    </div>
  );
}
