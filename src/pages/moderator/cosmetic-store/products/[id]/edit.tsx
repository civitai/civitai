import { Container, Stack, Title, Group, Text, Center, Loader } from '@mantine/core';
import { InferGetServerSidePropsType } from 'next';
import { useRouter } from 'next/router';
import { z } from 'zod';
import { BackButton } from '~/components/BackButton/BackButton';
import { CosmeticShopItemUpsertForm } from '~/components/CosmeticShop/CosmeticShopItemUpsertForm';
import { useQueryCosmeticShopItem } from '~/components/CosmeticShop/cosmetic-shop.util';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { showSuccessNotification } from '~/utils/notifications';

const querySchema = z.object({ id: z.coerce.number() });

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ session, ssg, ctx }) => {
    if (!session || !session?.user?.isModerator)
      return {
        redirect: {
          destination: '/',
          permanent: false,
        },
      };

    const result = querySchema.safeParse(ctx.params);
    if (!result.success) return { notFound: true };

    const { id } = result.data;
    const shopItem = await dbRead.cosmeticShopItem.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!shopItem) return { notFound: true };

    if (ssg) await ssg.cosmeticShop.getShopItemById.prefetch({ id });

    return {
      props: {
        id,
      },
    };
  },
});

export default function ProductEdit({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const router = useRouter();
  const { cosmeticShopItem, isLoading } = useQueryCosmeticShopItem({ id });

  const handleCancel = () => {
    router.push('/moderator/cosmetic-store/products');
  };

  const handleSuccess = () => {
    showSuccessNotification({
      title: 'Cosmetic shop product updated',
      message: 'Product has been updated successfully.',
    });

    router.push('/moderator/cosmetic-store/products');
  };

  if (isLoading || !cosmeticShopItem)
    return (
      <Container size="sm">
        <Center>
          <Loader size="md" />
        </Center>
      </Container>
    );

  return (
    <Container size="md">
      <Stack>
        <Group spacing="md" noWrap>
          <BackButton url="/moderator/cosmetic-store/products" />
          <Title>Update shop product {cosmeticShopItem.title}</Title>
        </Group>
        <Text>
          Note products will only be displayed in a store after you&rsquo;ve added them to at least
          1 section
        </Text>
        {isLoading ? (
          <Center>
            <Loader size="xl" />
          </Center>
        ) : (
          <CosmeticShopItemUpsertForm
            onSuccess={handleSuccess}
            onCancel={handleCancel}
            shopItem={cosmeticShopItem}
          />
        )}
      </Stack>
    </Container>
  );
}
