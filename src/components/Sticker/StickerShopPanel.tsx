import {
  CloseButton,
  Group,
  HoverCard,
  Loader,
  ScrollArea,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconInfoCircle, IconSearch, IconSticker } from '@tabler/icons-react';
import clsx from 'clsx';
import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { useQueryShop } from '~/components/CosmeticShop/cosmetic-shop.util';
import { useQueryCommunityCosmetics } from '~/components/CreatorShop/creator-shop.util';
import { useOwnedCosmeticIds } from '~/components/CreatorShop/Storefront/storefront.util';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { browseShopItems } from '~/components/Shop/shop-browse';
import { StickerPriceBadge } from '~/components/Sticker/StickerPriceBadge';
import { useStickerDragOut } from '~/components/Sticker/use-sticker-drag-out';
import { stickerPurchaseTerms } from '~/components/Sticker/sticker.util';
import { CosmeticShopSort } from '~/server/common/enums';
import type { StickerCosmetic } from '~/server/selectors/cosmetic.selector';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import { CIVITAI_SHOP_ATTRIBUTION } from '~/server/schema/cosmetic-shop.schema';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { numberWithCommas } from '~/utils/number-helpers';

// Loaded with the hover, not with the shelf. The creator card drags in profile
// cosmetics, live metrics and edge media, and the panel renders dozens of tiles
// whose cards nobody opens. Same reason the placed-sticker card defers it.
const SmartCreatorCard = dynamic(() =>
  import('~/components/CreatorCard/CreatorCard').then((m) => m.SmartCreatorCard)
);

/**
 * Wide enough that the creator card's top row never wraps — the same 400 the
 * placed-sticker hover card uses, and for the same reason: below about 385 the
 * cosmetic badge drops to its own line.
 */
const HOVER_CARD_WIDTH = 400;

/** The single page of the community catalog this panel holds client-side. */
const COMMUNITY_PAGE_SIZE = 100;

const matches = (query: string, ...fields: (string | null | undefined)[]) =>
  !query || fields.some((field) => field?.toLowerCase().includes(query));

type Tile = {
  shopItemId: number;
  cosmeticId: number;
  title: string;
  unitAmount: number;
  data: StickerCosmetic['data'];
  cosmeticData: unknown;
  viaShopUserId?: number;
  acceptsBlue: boolean;
  creatorUsername?: string | null;
  creator?: ({ id: number } & Partial<UserWithCosmetics>) | null;
  description?: string | null;
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
  maxScale,
}: {
  onClose: () => void;
  /** The space's own ceiling, so a sticker dragged from here starts inside it. */
  maxScale: number;
}) {
  const { grab, dragging } = useStickerDragOut(maxScale);
  const [search, setSearch] = useState('');
  // The community half searches server-side, so this is a request per keystroke
  // without the debounce. The official half is already in memory and filters
  // off `search` directly, so typing still feels immediate there.
  const [debouncedSearch] = useDebouncedValue(search.trim(), 300);

  const [domainBuzzType] = useAvailableBuzz();
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
    // Never shown: this shelf sells stickers, and one you own cannot be sold to
    // you again. Running low on uses is answered where you notice it — on the
    // sticker itself, in the row below — not by a second copy of it up here.
    owned: 'notOwned',
    query: debouncedSearch || undefined,
  });

  const isLoading = loadingOfficial || loadingCommunity;
  const query = search.trim().toLowerCase();

  const tiles = useMemo(() => {
    // Most-sold first, matching the order the community half is already asking
    // the server for, so the merged shelf has one order rather than two.
    const official = browseShopItems({
      entries: (cosmeticShopSections ?? []).flatMap((section) => section.items),
      shopItemOf: (entry) => entry.shopItem,
      listedAtOf: (entry) => entry.createdAt,
      filters: { cosmeticTypes: [CosmeticType.Sticker], modifier: 'notOwned' },
      sort: CosmeticShopSort.MostPopular,
      ownedCosmeticIds,
      wishlistedIds: new Set<number>(),
    })
      // Only this half is filtered here. The community half asked the server for
      // the search and got back what matched — re-testing those titles locally
      // would drop the ones that matched on the cosmetic's own name.
      .filter(({ shopItem }) => matches(query, shopItem.title, shopItem.cosmetic?.name))
      .map(({ shopItem }) => ({
        shopItemId: shopItem.id,
        cosmeticId: shopItem.cosmeticId,
        title: shopItem.title,
        unitAmount: shopItem.unitAmount,
        cosmeticData: shopItem.cosmetic?.data,
        meta: shopItem.meta,
        creatorUsername: shopItem.cosmetic?.creator?.username ?? null,
        creator: shopItem.cosmetic?.creator ?? null,
        description: shopItem.description,
        viaShopUserId: CIVITAI_SHOP_ATTRIBUTION,
      }));

    const community = communityItems.map((item) => ({
      shopItemId: item.id,
      cosmeticId: item.cosmeticId,
      title: item.title,
      unitAmount: item.unitAmount,
      cosmeticData: item.cosmetic?.data,
      meta: item.meta,
      // Who drew it, which is not always who listed it — a resold sticker is
      // sold by one creator and made by another, and the purchase line names
      // the maker.
      creatorUsername: item.cosmetic?.creator?.username ?? item.addedBy?.username ?? null,
      creator: item.cosmetic?.creator ?? item.addedBy ?? null,
      description: item.description,
      // Attributes the sale to the shop it was bought from, the same way the
      // storefront grid does.
      viaShopUserId: item.addedById ?? undefined,
    }));

    const seen = new Set<number>();

    return [...official, ...community].reduce<Tile[]>((acc, entry) => {
      if (entry.cosmeticId == null || seen.has(entry.shopItemId)) return acc;
      const data = entry.cosmeticData as StickerCosmetic['data'] | undefined;
      if (!data?.url) return acc;

      seen.add(entry.shopItemId);
      acc.push({
        shopItemId: entry.shopItemId,
        cosmeticId: entry.cosmeticId,
        title: entry.title,
        unitAmount: entry.unitAmount,
        data,
        cosmeticData: entry.cosmeticData,
        viaShopUserId: entry.viaShopUserId,
        acceptsBlue: !!(entry.meta as CosmeticShopItemMeta | null)?.acceptsBlueBuzz,
        creatorUsername: entry.creatorUsername,
        creator: entry.creator,
        description: entry.description,
      });
      return acc;
    }, []);
  }, [cosmeticShopSections, communityItems, ownedCosmeticIds, query]);

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
        <Tooltip
          label="Drag one onto the image to try it. You buy it before you can place it."
          withArrow
          multiline
          w={220}
        >
          <ThemeIcon size="sm" radius="xl" variant="subtle" color="gray">
            <IconInfoCircle size={16} />
          </ThemeIcon>
        </Tooltip>
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
                : 'Nothing new here — you already own every sticker on sale.'}
            </Text>
          )}

          {tiles.map((tile) => {
            const terms = stickerPurchaseTerms(tile.cosmeticData);

            return (
              <HoverCard
                key={tile.shopItemId}
                width={HOVER_CARD_WIDTH}
                withArrow
                // Portalled, or the panel's own `overflow-hidden` and the
                // scroll area inside it clip the card to the shelf — which on
                // the top row cut off everything but the title.
                withinPortal
                openDelay={200}
                position="top"
                offset={4}
                shadow="sm"
              >
                <HoverCard.Target>
                  {/* Artwork and a price, nothing else — the same shape as the
                      row of stickers you own below it. Names are long and vary
                      wildly in length, and a caption under each tile made a
                      shelf of ragged columns out of a set of equal squares. The
                      name is in the hover card, which is where the rest of the
                      detail is anyway. */}
                  <button
                    type="button"
                    aria-label={`Drag ${tile.title} onto the image`}
                    className={clsx(
                      'relative flex shrink-0 cursor-grab flex-col items-center rounded border p-2',
                      dragging === tile.cosmeticId ? 'border-blue-5' : 'border-transparent'
                    )}
                    style={{ touchAction: 'none' }}
                    onPointerDown={grab(tile.cosmeticId, {
                      pack: {
                        shopItemId: tile.shopItemId,
                        unitAmount: tile.unitAmount,
                        acceptsBlue: tile.acceptsBlue,
                        viaShopUserId: tile.viaShopUserId,
                      },
                      creatorUsername: tile.creatorUsername,
                    })}
                  >
                    <EdgeImage
                      src={tile.data.url}
                      alt={tile.data.slug ? `:${tile.data.slug}:` : tile.title}
                      options={{ height: 96, anim: tile.data.animated, optimized: true }}
                      style={{ height: 48, width: 'auto', pointerEvents: 'none' }}
                      draggable={false}
                    />
                    <StickerPriceBadge
                      className="mt-1"
                      amount={tile.unitAmount}
                      // Blue first where the seller takes it, so the badge is the
                      // colour of the Buzz this would actually spend — and the
                      // same colour as the button it turns into on the image.
                      accountTypes={tile.acceptsBlue ? ['blue', domainBuzzType] : [domainBuzzType]}
                    />
                  </button>
                </HoverCard.Target>
                {/* Same shape as the card you get hovering a placed sticker:
                    a bordered title row, the words in the middle, and the
                    creator card edge to edge at the bottom carrying its own
                    padding. */}
                <HoverCard.Dropdown p={0}>
                  <div className="border-b border-gray-3 px-3 py-2 dark:border-dark-4">
                    <Group gap={6} wrap="nowrap">
                      <IconSticker size={14} className="shrink-0 text-yellow-6" />
                      <Text size="sm" fw={600} lineClamp={1}>
                        {tile.title}
                      </Text>
                    </Group>
                    <Text size="xs" c="dimmed">
                      {numberWithCommas(tile.unitAmount)} Buzz · {terms.usesLabel}
                      {terms.extraUseLabel ? ` · ${terms.extraUseLabel}` : ''}
                    </Text>
                  </div>

                  {tile.description && (
                    <div className="border-b border-gray-3 px-3 py-2 text-sm dark:border-dark-4">
                      <RenderHtml html={tile.description} />
                    </div>
                  )}

                  {tile.creator && (
                    <SmartCreatorCard user={tile.creator} withActions={false} withBorder={false} />
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
