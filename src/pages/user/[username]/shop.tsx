import {
  Badge,
  Button,
  Center,
  Chip,
  Group,
  Loader,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
  useComputedColorScheme,
} from '@mantine/core';
import {
  IconBuildingStore,
  IconPlus,
  IconSettings,
  IconShoppingBag,
  IconStar,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Fragment, useMemo, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { useQueryCreatorShop } from '~/components/CreatorShop/creator-shop.util';
import { ShopItem } from '~/components/Shop/ShopItem';
import type { CosmeticShopItemGetById } from '~/types/router';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { dbRead } from '~/server/db/client';
import type { CreatorShopSectionKey } from '~/server/schema/creator-shop.schema';
import { creatorShopSectionKeys } from '~/server/schema/creator-shop.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getDisplayName, postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, features, ssg }) => {
    const username = ctx.query.username as string;
    if (!features?.creatorShop)
      return { redirect: { destination: `/user/${username}`, permanent: false } };

    const user = await dbRead.user.findUnique({ where: { username }, select: { bannedAt: true } });
    if (user?.bannedAt) return { redirect: { destination: `/user/${username}`, permanent: true } };

    await Promise.all([
      ssg?.userProfile.get.prefetch({ username }),
      ssg?.userProfile.overview.prefetch({ username }),
    ]);
  },
});

type SortKey = 'newest' | 'price-asc' | 'price-desc' | 'name';

const SECTION_ICON_SIZE = 18;

function UserShopPage() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const username = (router.query.username as string) ?? '';
  const { data: user } = trpc.userProfile.get.useQuery({ username }, { enabled: !!username });
  const { shop, isLoading } = useQueryCreatorShop(user?.id);
  const isOwner =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);

  const colorScheme = useComputedColorScheme('dark');
  const [type, setType] = useState<string>('all');
  const [sort, setSort] = useState<SortKey>('newest');

  const cosmeticTypes = useMemo(
    () => Array.from(new Set((shop?.cosmetics ?? []).map((c) => c.cosmetic.type))),
    [shop?.cosmetics]
  );

  const cosmetics = useMemo(() => {
    let list = [...(shop?.cosmetics ?? [])];
    if (type !== 'all') list = list.filter((c) => c.cosmetic.type === type);
    switch (sort) {
      case 'price-asc':
        list.sort((a, b) => a.unitAmount - b.unitAmount);
        break;
      case 'price-desc':
        list.sort((a, b) => b.unitAmount - a.unitAmount);
        break;
      case 'name':
        list.sort((a, b) => a.title.localeCompare(b.title));
        break;
    }
    return list;
  }, [shop?.cosmetics, type, sort]);

  const sectionOrder = useMemo<CreatorShopSectionKey[]>(() => {
    const configured = shop?.settings.sections;
    if (configured && configured.length)
      return configured.filter((s) => s.visible).map((s) => s.key);
    return [...creatorShopSectionKeys];
  }, [shop?.settings.sections]);

  if (!username) return <NotFound />;

  const baseUrl = `/user/${username}`;
  const isEmpty = !isLoading && (shop?.cosmetics.length ?? 0) === 0;
  const description = shop?.settings.description?.trim();

  const featuredSection = shop?.featured.length ? (
    <Paper
      key="featured"
      radius="lg"
      p="lg"
      style={{
        border: '1px solid #f0b45540',
        background:
          colorScheme === 'dark'
            ? 'linear-gradient(160deg, #282318, #1e1f24)'
            : 'linear-gradient(160deg, #fff8ec, #fdf3e0)',
      }}
    >
      <Stack gap="md">
        <Group justify="space-between" align="center" wrap="nowrap">
          <Group gap={8} align="center">
            <IconStar
              size={SECTION_ICON_SIZE}
              color="var(--mantine-color-yellow-5)"
              fill="var(--mantine-color-yellow-5)"
            />
            <Title order={3}>Featured</Title>
          </Group>
          <Text size="xs" c="dimmed">
            Hand-picked by {user?.username ?? username}
          </Text>
        </Group>
        <SimpleGrid cols={{ base: 1, xs: 2, sm: 3 }} spacing="md">
          {shop.featured.map((item) => (
            <ShopItem
              key={item.id}
              item={item as unknown as CosmeticShopItemGetById}
              sectionItemCreatedAt={item.createdAt}
            />
          ))}
        </SimpleGrid>
      </Stack>
    </Paper>
  ) : null;

  const cosmeticsSection = (
    <Stack key="cosmetics" gap="md">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <div>
          <Group gap={8} align="center">
            <Title order={4}>Cosmetics</Title>
            <Badge variant="light" color="gray" radius="sm">
              {shop?.cosmetics.length ?? 0}
            </Badge>
          </Group>
          <Text size="xs" c="dimmed">
            Badges, frames, nameplates &amp; decorations
          </Text>
        </div>
        <Group gap="xs">
          <Chip.Group multiple={false} value={type} onChange={(v) => setType(v as string)}>
            <Group gap={6}>
              <Chip value="all" size="xs" variant="filled">
                All types
              </Chip>
              {cosmeticTypes.map((t) => (
                <Chip key={t} value={t} size="xs" variant="filled">
                  {getDisplayName(t)}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
          <Select
            size="xs"
            w={160}
            value={sort}
            onChange={(v) => setSort((v as SortKey) ?? 'newest')}
            data={[
              { value: 'newest', label: 'Newest' },
              { value: 'price-asc', label: 'Price: Low to high' },
              { value: 'price-desc', label: 'Price: High to low' },
              { value: 'name', label: 'Name' },
            ]}
          />
        </Group>
      </Group>
      <SimpleGrid cols={{ base: 1, xs: 2, sm: 3, md: 4 }} spacing="md">
        {cosmetics.map((item) => (
          <ShopItem
            key={item.id}
            item={item as unknown as CosmeticShopItemGetById}
            sectionItemCreatedAt={item.createdAt}
          />
        ))}
      </SimpleGrid>
    </Stack>
  );

  const merchSection = (
    <Stack key="merch" gap="md">
      <Group gap={8} align="center">
        <IconShoppingBag size={SECTION_ICON_SIZE} />
        <Title order={4}>Merch</Title>
        <Badge variant="light" color="yellow" radius="sm">
          Coming soon
        </Badge>
      </Group>
      <Paper withBorder radius="md" p={40}>
        <Stack align="center" gap={8}>
          <ThemeIcon size={48} radius="xl" variant="light" color="gray">
            <IconShoppingBag size={24} />
          </ThemeIcon>
          <Text fw={600}>Merch is coming soon</Text>
          <Text size="sm" c="dimmed" ta="center">
            Print-on-demand apparel &amp; goods will be available here shortly.
          </Text>
        </Stack>
      </Paper>
    </Stack>
  );

  const modelsSection = shop?.settings.showModels ? (
    <Stack key="models" gap="md">
      <Group gap={8} align="center">
        <IconBuildingStore size={SECTION_ICON_SIZE} />
        <Title order={4}>Models</Title>
      </Group>
      <Text size="sm" c="dimmed">
        Models by {user?.username ?? username} will appear here.
      </Text>
    </Stack>
  ) : null;

  const sectionContent: Record<CreatorShopSectionKey, React.ReactNode> = {
    featured: featuredSection,
    cosmetics: cosmeticsSection,
    merch: merchSection,
    models: modelsSection,
  };

  return (
    <Stack gap="xl" mt="md" pb="xl">
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          <Group gap={8} align="center">
            <IconShoppingBag size={22} />
            <Title order={2}>Shop</Title>
          </Group>
          <Text size="sm" c="dimmed">
            Cosmetics{shop?.settings.showModels ? ' & models' : ''} by {user?.username ?? username}
          </Text>
          {description ? (
            <Text size="sm" mt={4} className="max-w-2xl">
              {description}
            </Text>
          ) : isOwner ? (
            <Text size="xs" c="dimmed" fs="italic" mt={4}>
              Add a shop description in Shop settings.
            </Text>
          ) : null}
        </Stack>
        {isOwner && (
          <Group gap="xs">
            <Button
              component={Link}
              href={`${baseUrl}/shop/manage`}
              variant="default"
              leftSection={<IconSettings size={16} />}
            >
              Manage
            </Button>
            <Button
              component={Link}
              href={`${baseUrl}/shop/manage`}
              leftSection={<IconPlus size={16} />}
            >
              Submit an item
            </Button>
          </Group>
        )}
      </Group>

      {isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : isEmpty ? (
        <Paper withBorder radius="md" p="xl">
          <Stack align="center" gap="sm">
            <ThemeIcon size={56} radius="xl" variant="light" color="gray">
              <IconBuildingStore size={30} />
            </ThemeIcon>
            <Title order={4}>{isOwner ? 'Your shop is empty' : 'This shop is empty'}</Title>
            <Text size="sm" c="dimmed" ta="center" maw={440}>
              {isOwner
                ? 'List cosmetics for your fans to collect and buy with Buzz. Submit your first item to open your shop.'
                : `${user?.username ?? username} hasn't listed anything yet.`}
            </Text>
            {isOwner && (
              <Button
                component={Link}
                href={`${baseUrl}/shop/manage`}
                leftSection={<IconPlus size={16} />}
              >
                Submit an item
              </Button>
            )}
          </Stack>
        </Paper>
      ) : (
        <Stack gap="xl">
          {sectionOrder.map((key) => {
            const node = sectionContent[key];
            return node ? <Fragment key={key}>{node}</Fragment> : null;
          })}
        </Stack>
      )}
    </Stack>
  );
}

export default Page(UserShopPage, { getLayout: UserProfileLayout });
