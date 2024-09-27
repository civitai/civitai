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
} from '@mantine/core';
import { IconBell, IconBellOff, IconPencilMinus } from '@tabler/icons-react';
import { useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { env } from '~/env/client.mjs';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import {
  useCosmeticShopQueryParams,
  useQueryShop,
  useShopLastViewed,
} from '~/components/CosmeticShop/cosmetic-shop.util';
import { CosmeticShopSectionMeta, GetShopInput } from '~/server/schema/cosmetic-shop.schema';
import { openUserProfileEditModal } from '~/components/Modals/UserProfileEditModal';
import { ShopFiltersDropdown } from '~/components/CosmeticShop/ShopFiltersDropdown';
import { useDebouncedValue } from '@mantine/hooks';
import { useEffect } from 'react';
import { NotificationToggle } from '~/components/Notifications/NotificationToggle';
import { ShopItem } from '~/components/Shop/ShopItem';
import { ShopSection } from '~/components/Shop/ShopSection';
import Image from 'next/image';
import { isEmpty } from 'lodash-es';
import { formatPriceForDisplay } from '~/utils/number-helpers';

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
          {isEmpty(filters) && <ArtistShowcaseSection />}
          {isLoading ? (
            <Center p="xl">
              <Loader />
            </Center>
          ) : cosmeticShopSections?.length > 0 ? (
            cosmeticShopSections.map((section) => {
              const { image, items } = section;
              const meta = section.meta as CosmeticShopSectionMeta;

              return (
                <ShopSection
                  key={section.id}
                  title={section.title}
                  description={section.description}
                  imageUrl={image?.url}
                  hideTitle={meta.hideTitle}
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
        </Stack>
      </Container>
    </>
  );
}

const showcaseProducts = [
  {
    name: 'The Digital Feline I',
    description: '',
    price: 3000,
    imageUrl: '/images/shop/civitai-air/digital-feline-i.png',
    hoverImageUrl: '/images/shop/civitai-air/digital-feline-i-alt.png',
    url: 'https://shop.civitai.com/products/digital-feline-i',
  },
  {
    name: 'The Digital Feline II',
    description: '',
    price: 3000,
    imageUrl: '/images/shop/civitai-air/digital-feline-ii.png',
    hoverImageUrl: '/images/shop/civitai-air/digital-feline-ii-alt.png',
    url: 'https://shop.civitai.com/products/digital-felines-ii',
  },
  {
    name: 'The Digital Feline III',
    description: '',
    price: 3000,
    imageUrl: '/images/shop/civitai-air/digital-feline-iii.png',
    hoverImageUrl: '/images/shop/civitai-air/digital-feline-iii-alt.png',
    url: 'https://shop.civitai.com/products/digital-feline-iii',
  },
  {
    name: 'The Digital Feline IV',
    description: '',
    price: 3000,
    imageUrl: '/images/shop/civitai-air/digital-feline-iv.png',
    hoverImageUrl: '/images/shop/civitai-air/digital-feline-iv-alt.png',
    url: 'https://shop.civitai.com/products/digital-feline-iv',
  },
];

function ArtistShowcaseSection() {
  return (
    <section className="flex flex-col gap-8">
      <div className="hidden w-full overflow-hidden rounded-[20px] md:block">
        <Image
          src="/images/shop/civitai-air/anne-horel-banner.png"
          width={2400}
          height={800}
          alt="banner depicting several AI generated picture from artist Anne Horel"
        />
      </div>
      <div className="block w-full overflow-hidden rounded-[20px] md:hidden">
        <Image
          src="/images/shop/civitai-air/anne-horel-mobile.png"
          width={1087}
          height={960}
          alt="banner depicting several AI generated picture from artist Anne Horel"
        />
      </div>
      <div className="flex flex-col lg:px-11">
        <Text size={32} weight={600}>
          The backstory
        </Text>
        <Text size={24} lh="40px" color="dimmed">
          Civitai AiR is proud to present this limited edition t-shirt set by Artist Anne Horel,
          featuring her AI generated masks. Part of her upcoming exhibition at Julie Caredda Gallery
          in Paris, each unique design is limited to an edition of 25.
        </Text>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-10 lg:px-11">
        {showcaseProducts.map((product) => (
          <div
            key={product.imageUrl}
            className="flex flex-col items-center justify-center gap-6 rounded-[20px] bg-[#2F2F2F] p-6"
          >
            <div className="relative">
              <Image
                src={product.imageUrl}
                alt="t-shirt with an AI generated face of a cat"
                width={598}
                height={560}
              />
              <div className="absolute left-0 top-0 opacity-0 transition-opacity duration-300 hover:opacity-100">
                <Image
                  src={product.hoverImageUrl}
                  alt="t-shirt with an AI generated face of a cat"
                  width={598}
                  height={560}
                />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Text size={28} weight="bold">
                {product.name}
              </Text>
              {product.description && (
                <Text size={24} color="dimmed">
                  {product.description}
                </Text>
              )}
            </div>
            <Button
              component="a"
              href={product.url}
              rel="nofollow noreferrer"
              size="xl"
              target="_blank"
              color="dark.4"
              radius="xl"
              fullWidth
            >
              ${formatPriceForDisplay(product.price)} - Buy Now
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
