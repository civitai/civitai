import { Center, Loader } from '@mantine/core';
import { useState } from 'react';
import { useDebouncedValue } from '@mantine/hooks';
import { ShopFiltersDropdown } from '~/components/CosmeticShop/ShopFiltersDropdown';
import { useQueryWishlistedShopItems } from '~/components/CosmeticShop/cosmetic-shop.util';
import { useQueryCommunityCosmetics } from '~/components/CreatorShop/creator-shop.util';
import { useOwnedCosmeticIds } from '~/components/CreatorShop/Storefront/storefront.util';
import { creatorShopFilterTypes } from '~/components/CreatorShop/Submit/submit.constants';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NoContent } from '~/components/NoContent/NoContent';
import { ShopItem } from '~/components/Shop/ShopItem';
import { ShopSection } from '~/components/Shop/ShopSection';
import type { GetShopInput } from '~/server/schema/cosmetic-shop.schema';
import type { CosmeticShopItemGetById } from '~/types/router';

// Global marketplace hub on /shop: one infinite feed of every published
// community cosmetic across all creator shops, filterable by type. Placement,
// banner, and copy come from the mod-managed section row (meta.communityHub).
export function CommunityCosmeticsSection({
  title,
  description,
  imageUrl,
  hideTitle,
  className,
}: {
  title: string;
  description?: string | null;
  imageUrl?: string | null;
  hideTitle?: boolean;
  className?: string;
}) {
  const [filters, setFilters] = useState<GetShopInput>({});
  const [debouncedTypes] = useDebouncedValue(filters.cosmeticTypes, 500);
  const { items, isLoading, isRefetching, fetchNextPage, hasNextPage } = useQueryCommunityCosmetics(
    { cosmeticTypes: debouncedTypes?.length ? debouncedTypes : undefined }
  );
  const ownedCosmeticIds = useOwnedCosmeticIds();
  const { wishlistedIds } = useQueryWishlistedShopItems();

  // Nothing published yet — keep /shop clean rather than showing an empty hub.
  if (!isLoading && !items.length && !filters.cosmeticTypes?.length) return null;

  return (
    <ShopSection
      title={title}
      description={description}
      imageUrl={imageUrl}
      hideTitle={hideTitle}
      className={className}
    >
      <div className="flex flex-col gap-4">
        <div className="ml-auto">
          <ShopFiltersDropdown
            filters={filters}
            setFilters={setFilters}
            availableTypes={creatorShopFilterTypes}
            hideModifiers
          />
        </div>
        {isLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : items.length ? (
          <>
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
                  creator={item.cosmetic?.creator}
                />
              ))}
            </div>
            {hasNextPage && (
              <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching}>
                <Center p="xl" style={{ height: 36 }} mt="md">
                  <Loader />
                </Center>
              </InViewLoader>
            )}
          </>
        ) : (
          <NoContent message="No cosmetics match your filters." />
        )}
      </div>
    </ShopSection>
  );
}
