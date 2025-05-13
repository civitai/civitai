import {
  Button,
  Center,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  Title,
  ActionIcon,
  Tooltip,
  SimpleGrid,
} from '@mantine/core';
import { IconBell, IconBellOff, IconPencilMinus } from '@tabler/icons-react';
import { useState } from 'react';
import { isEmpty } from 'lodash-es';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { env } from '~/env/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import {
  useCosmeticShopQueryParams,
  useQueryShop,
  useShopLastViewed,
} from '~/components/CosmeticShop/cosmetic-shop.util';
import { CosmeticShopSectionMeta, GetShopInput } from '~/server/schema/cosmetic-shop.schema';
import { openUserProfileEditModal } from '~/components/Modals/UserProfileEditModal';
import { ShopFiltersDropdown } from '~/components/CosmeticShop/ShopFiltersDropdown';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { useEffect } from 'react';
import { NotificationToggle } from '~/components/Notifications/NotificationToggle';
import { ShopItem } from '~/components/Shop/ShopItem';
import { ShopSection } from '~/components/Shop/ShopSection';
import Image from 'next/image';
import { formatPriceForDisplay } from '~/utils/number-helpers';

import merchProducts from '~/utils/shop/civitai-merch-products.json';
import projectOdysseyProducts from '~/utils/shop/project-odyssey-products.json';
import clsx from 'clsx';

const merchSections = {
  civitai: {
    bannerImage: {
      url: '/images/shop/civitai-merch/civitai-merch-banner.png',
      width: 2040,
      height: 392,
    },
    description: '',
    products: merchProducts,
  },
  projectOdyssey: {
    bannerImage: {
      url: '/images/shop/project-odyssey/project-odyssey-banner.png',
      width: 2544,
      height: 496,
    },
    description: '',
    products: projectOdysseyProducts,
  },
} as const;

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ssg, features }) => {
    if (!features?.cosmeticShop) return { notFound: true };

    await ssg?.cosmeticShop.getShop.prefetch({});
  },
});

export default function CosmeticShopMain() {
  const { query } = useCosmeticShopQueryParams();
  const [filters, setFilters] = useState<GetShopInput>({
    ...(query ?? {}),
  });
  const [debouncedFilters] = useDebouncedValue(filters, 500);
  const { cosmeticShopSections, isLoading } = useQueryShop(debouncedFilters);

  const { updateLastViewed, isFetched } = useShopLastViewed();

  useEffect(() => {
    setFilters(query);
  }, [query]);

  useEffect(() => {
    if (isFetched) {
      // Update last viewed
      updateLastViewed();
    }
  }, [isFetched]);

  return (
    <>
      <Meta
        title="Civitai Cosmetic Shop | Created with Love & AI"
        description="Civitai Cosmetic Shop is a place where you can find the best cosmetic products to really express youself."
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/builds`, rel: 'canonical' }]}
      />
      <Container size="xl" p="sm">
        <Stack spacing="xl">
          <Stack spacing={0}>
            <Group noWrap position="apart">
              <Title>Civitai Cosmetic Shop</Title>

              <Group>
                <Button
                  leftIcon={<IconPencilMinus size={16} />}
                  onClick={() => {
                    openUserProfileEditModal({});
                  }}
                  sx={{ fontSize: 14, fontWeight: 600, lineHeight: 1.5 }}
                  radius="xl"
                  compact
                >
                  Customize profile
                </Button>
                <NotificationToggle type="cosmetic-shop-item-added-to-section">
                  {({ onToggle, isEnabled, isLoading }) => (
                    <ActionIcon onClick={onToggle} loading={isLoading}>
                      <Tooltip
                        w={200}
                        multiline
                        withArrow
                        label={`${
                          isEnabled ? 'Do not notify me' : 'Notify me'
                        } about new items in the shop.`}
                      >
                        {isEnabled ? <IconBellOff /> : <IconBell />}
                      </Tooltip>
                    </ActionIcon>
                  )}
                </NotificationToggle>
              </Group>
            </Group>
            <Text size="sm" color="dimmed" mb="sm">
              Any cosmetic purchases directly contributes to Civitai ❤️
            </Text>
          </Stack>
          <div className="ml-auto">
            <ShopFiltersDropdown filters={filters} setFilters={setFilters} />
          </div>
          <div className="flex flex-col gap-6">
            {isEmpty(filters) && <MerchShowcaseSection type="civitai" className="order-2" />}
            {isLoading ? (
              <Center p="xl">
                <Loader />
              </Center>
            ) : cosmeticShopSections?.length > 0 ? (
              cosmeticShopSections.map((section, index) => {
                const { image, items } = section;
                const meta = section.meta as CosmeticShopSectionMeta;
                const className = clsx(index === 0 ? 'order-1' : `order-3`);

                return (
                  <ShopSection
                    key={section.id}
                    title={section.title}
                    description={section.description}
                    imageUrl={image?.url}
                    hideTitle={meta.hideTitle}
                    className={className}
                  >
                    <ShopSection.Items>
                      {items.map((item) => {
                        const { shopItem } = item;
                        return (
                          <ShopItem
                            key={shopItem.id}
                            item={shopItem}
                            sectionItemCreatedAt={item.createdAt}
                          />
                        );
                      })}
                    </ShopSection.Items>
                  </ShopSection>
                );
              })
            ) : (
              <NoContent message="It looks like we're still working on some changes. Please come back later." />
            )}
          </div>
        </Stack>
      </Container>
    </>
  );
}

const MAX_SHOWN_ITEMS = 4;

function MerchShowcaseSection({
  type,
  className,
}: {
  type: keyof typeof merchSections;
  className?: string;
}) {
  const [opened, { open, close }] = useDisclosure();
  const merch = merchSections[type];
  const displayedItems = merch.products.slice(0, MAX_SHOWN_ITEMS);
  const collapsedItems = merch.products.slice(MAX_SHOWN_ITEMS);

  return (
    <section className={clsx('flex flex-col gap-8', className)}>
      <div className="hidden w-full overflow-hidden rounded-[20px] md:block">
        <Image
          src={merch.bannerImage.url}
          width={merch.bannerImage.width}
          height={merch.bannerImage.height}
          alt="banner depicting merch section"
        />
      </div>
      <div className="block h-44 w-full overflow-hidden rounded-[20px] md:hidden">
        <Image
          src={merch.bannerImage.url}
          className="h-full object-cover object-center"
          width={merch.bannerImage.width}
          height={merch.bannerImage.height}
          alt="banner depicting merch section"
        />
      </div>
      {/* <div className="flex flex-col lg:px-11">
        <Text size={32} weight={600}>
          The backstory
        </Text>
        <Text size={24} lh="40px" color="dimmed">
          Civitai AiR is proud to present this limited edition t-shirt set by Artist Anne Horel,
          featuring her AI generated masks. Part of her upcoming exhibition at Julie Caredda Gallery
          in Paris, each unique design is limited to an edition of 25.
        </Text>
      </div> */}
      <SimpleGrid
        spacing="md"
        breakpoints={[
          { minWidth: 'xs', cols: 1 },
          { minWidth: 'sm', cols: 3 },
          { minWidth: 'lg', cols: 4 },
        ]}
      >
        {displayedItems.map((product) => (
          <ProductItem key={product.imageUrl} {...product} />
        ))}
        {opened
          ? collapsedItems.map((product) => <ProductItem key={product.imageUrl} {...product} />)
          : null}
      </SimpleGrid>
      {collapsedItems.length > 0 && (
        <Button
          onClick={opened ? close : open}
          color="dark.4"
          radius="xl"
          className="mt-auto"
          fullWidth
        >
          {opened ? 'Show Less' : `View all (${collapsedItems.length} more)`}
        </Button>
      )}
    </section>
  );
}

function ProductItem({
  name,
  description,
  imageUrl,
  imageAlt,
  hoverImageUrl,
  price,
  url,
}: (typeof merchProducts)[number]) {
  return (
    <div key={imageUrl} className="flex flex-col gap-4 rounded-lg bg-[#2F2F2F] p-4">
      <div className="relative mx-auto w-52 overflow-hidden rounded-lg">
        <Image src={imageUrl} alt={imageAlt} width={1000} height={1000} />
        {hoverImageUrl && (
          <div className="absolute left-0 top-0 opacity-0 transition-opacity duration-300 hover:opacity-100">
            <Image src={hoverImageUrl} alt={imageAlt} width={1000} height={1000} />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <Text size={22} weight="bold">
          {name}
        </Text>
        {description && (
          <Text size={16} lineClamp={3}>
            {description}
          </Text>
        )}
      </div>
      <Button
        component="a"
        className="mt-auto"
        href={url}
        rel="nofollow noreferrer"
        target="_blank"
        color="dark.4"
        radius="xl"
        fullWidth
      >
        ${formatPriceForDisplay(price)} - Buy Now
      </Button>
    </div>
  );
}
