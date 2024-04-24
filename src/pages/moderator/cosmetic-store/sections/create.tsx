import { Container, Stack, Title, Group, Text } from '@mantine/core';
import { useRouter } from 'next/router';
import { BackButton } from '~/components/BackButton/BackButton';
import { CosmeticShopSectionUpsertForm } from '~/components/CosmeticShop/CosmeticShopSectionUpsertForm';
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

export default function SectionsCreate() {
  const router = useRouter();

  const handleCancel = () => {
    router.push('/moderator/cosmetic-store/sections');
  };

  const handleSuccess = () => {
    showSuccessNotification({
      title: 'Club post created',
      message: 'Your post was created and is now part of your club',
    });

    router.push('/moderator/cosmetic-store/sections');
  };

  return (
    <Container size="md">
      <Stack>
        <Group spacing="md" noWrap>
          <BackButton url="/moderator/cosmetic-store/sections" />
          <Title>Create new cosmetic shop section</Title>
        </Group>
        <Text>
          In order for this section to be displayed in the store, you must add at least one product
          to it.
        </Text>
        <CosmeticShopSectionUpsertForm onSuccess={handleSuccess} onCancel={handleCancel} />
      </Stack>
    </Container>
  );
}
