import { Center, Loader, LoadingOverlay } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type { ShopFilters } from '~/components/CosmeticShop/ShopFiltersDropdown';
import { useQueryWishlistedShopItems } from '~/components/CosmeticShop/cosmetic-shop.util';
import { useQueryCommunityCosmetics } from '~/components/CreatorShop/creator-shop.util';
import { useOwnedCosmeticIds } from '~/components/CreatorShop/Storefront/storefront.util';
import { NoContent } from '~/components/NoContent/NoContent';
import { ShopBrowsePagination } from '~/components/Shop/ShopBrowseControls';
import { shopBrowseKey, useResettingPage } from '~/components/Shop/shop-browse';
import { ShopItem } from '~/components/Shop/ShopItem';
import { ShopSection } from '~/components/Shop/ShopSection';
import type { CosmeticShopSort } from '~/server/common/enums';
import type { CosmeticShopItemGetById } from '~/types/router';

// Global marketplace hub on /shop: every published community cosmetic across all
// creator shops. Driven by the page's filter bar like every other section — it
// just applies them server-side, because it browses the whole catalog rather
// than a list it already holds. Placement, banner, and copy come from the
// mod-managed section row (meta.communityHub).
export function CommunityCosmeticsSection({
  title,
  description,
  imageUrl,
  hideTitle,
  className,
  filters,
  sort,
  pageSize,
}: {
  title: string;
  description?: string | null;
  imageUrl?: string | null;
  hideTitle?: boolean;
  className?: string;
  filters: ShopFilters;
  sort: CosmeticShopSort;
  pageSize: number;
}) {
  const [page, setPage] = useResettingPage(shopBrowseKey(filters, sort, pageSize));
  // Type chips are multi-select, so a viewer picking three fires three queries
  // without this. The other filters are one click each.
  const [debouncedTypes] = useDebouncedValue(filters.cosmeticTypes, 500);

  const { items, totalPages, isLoading, isFetching } = useQueryCommunityCosmetics({
    cosmeticTypes: debouncedTypes?.length ? debouncedTypes : undefined,
    sort,
    page,
    limit: pageSize,
    wishlisted: filters.wishlisted || undefined,
    owned: filters.modifier,
    limited: filters.limited || undefined,
    acceptsBlueBuzz: filters.acceptsBlueBuzz || undefined,
  });
  const ownedCosmeticIds = useOwnedCosmeticIds();
  const { wishlistedIds } = useQueryWishlistedShopItems();

  // Pending *or* applied types count: for the 500ms the debounce is in flight
  // the two disagree, and taking either one alone flickers the whole section
  // out on the edge where the empty result belongs to the other.
  const hasFilters =
    !!filters.cosmeticTypes?.length ||
    !!debouncedTypes?.length ||
    !!filters.wishlisted ||
    !!filters.modifier ||
    !!filters.limited ||
    !!filters.acceptsBlueBuzz;

  // Nothing published yet — keep /shop clean rather than showing an empty hub.
  // Once the viewer has narrowed it themselves the section stays, so an empty
  // result reads as "nothing matched" rather than the hub vanishing.
  if (!isLoading && !items.length && !hasFilters && page === 1) return null;

  return (
    <ShopSection
      title={title}
      description={description}
      imageUrl={imageUrl}
      hideTitle={hideTitle}
      className={className}
    >
      <div className="flex flex-col gap-4">
        {isLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : items.length ? (
          <>
            <div className="relative">
              <LoadingOverlay visible={isFetching} zIndex={9} />
              <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
                {items.map((item) => (
                  <ShopItem
                    key={item.id}
                    item={item as unknown as CosmeticShopItemGetById}
                    sectionItemCreatedAt={item.createdAt}
                    alreadyOwned={item.cosmeticId != null && ownedCosmeticIds.has(item.cosmeticId)}
                    wishlisted={wishlistedIds.has(item.id)}
                    // Attribute the purchase to the owner's shop so the creator
                    // keeps their full pool (never the platform-reseller split).
                    viaShopUserId={item.addedById ?? undefined}
                    creator={item.cosmetic?.creator ?? item.addedBy}
                  />
                ))}
              </div>
            </div>
            <ShopBrowsePagination page={page} onChange={setPage} totalPages={totalPages} />
          </>
        ) : (
          <NoContent message="No cosmetics match your filters." />
        )}
      </div>
    </ShopSection>
  );
}
