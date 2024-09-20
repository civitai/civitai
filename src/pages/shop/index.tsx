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
          <Stack ml="auto">
            <ShopFiltersDropdown filters={filters} setFilters={setFilters} />
          </Stack>
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
