import { Container, Stack, Title, Group, Text } from '@mantine/core';
import { useRouter } from 'next/router';
import { BackButton } from '~/components/BackButton/BackButton';
import { CosmeticShopItemUpsertForm } from '~/components/CosmeticShop/CosmeticShopItemUpsertForm';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { showSuccessNotification } from '~/utils/notifications';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session || !session?.user?.isModerator)
      return {
        redirect: {
          destination: '/',
          permanent: false,
        },
      };
  },
});

export default function ProductsCreate() {
  const router = useRouter();

  const handleCancel = () => {
    router.push('/moderator/cosmetic-store/products');
  };

  const handleSuccess = () => {
    showSuccessNotification({
      title: 'A new cosmetic shop product was created',
      message: 'You can now add this product to a section in the store.',
    });

    router.push('/moderator/cosmetic-store/products');
  };

  return (
    <Container size="md">
      <Stack>
        <Group spacing="md" noWrap>
          <BackButton url="/moderator/cosmetic-store/products" />
          <Title>Create new cosmetic shop product</Title>
        </Group>
        <Text>
          Note products will only be displayed in a store after you&rsquo;ve added them to at least
          1 section
        </Text>
        <CosmeticShopItemUpsertForm onSuccess={handleSuccess} onCancel={handleCancel} />
      </Stack>
    </Container>
  );
}
