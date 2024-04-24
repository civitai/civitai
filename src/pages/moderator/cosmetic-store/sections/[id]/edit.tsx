import { Container, Stack, Title, Group, Text, Center, Loader } from '@mantine/core';
import { InferGetServerSidePropsType } from 'next';
import { useRouter } from 'next/router';
import { z } from 'zod';
import { BackButton } from '~/components/BackButton/BackButton';
import { CosmeticShopItemUpsertForm } from '~/components/CosmeticShop/CosmeticShopItemUpsertForm';
import { CosmeticShopSectionUpsertForm } from '~/components/CosmeticShop/CosmeticShopSectionUpsertForm';
import {
  useQueryCosmeticShopItem,
  useQueryCosmeticShopSection,
} from '~/components/CosmeticShop/cosmetic-shop.util';
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
    const shopSection = await dbRead.cosmeticShopSection.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!shopSection) return { notFound: true };

    if (ssg) await ssg.cosmeticShop.getSectionById.prefetch({ id });

    return {
      props: {
        id,
      },
    };
  },
});

export default function SectionEdit({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const router = useRouter();
  const { cosmeticShopSection, isLoading } = useQueryCosmeticShopSection({ id });

  const handleCancel = () => {
    router.push('/moderator/cosmetic-store/sections');
  };

  const handleSuccess = () => {
    showSuccessNotification({
      title: 'Cosmetic shop product updated',
      message: 'Product has been updated successfully.',
    });

    router.push('/moderator/cosmetic-store/sections');
  };

  if (isLoading || !cosmeticShopSection)
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
          <BackButton url="/moderator/cosmetic-store/sections" />
          <Title>Update shop section: {cosmeticShopSection.title}</Title>
        </Group>
        {isLoading ? (
          <Center>
            <Loader size="xl" />
          </Center>
        ) : (
          <CosmeticShopSectionUpsertForm
            onSuccess={handleSuccess}
            onCancel={handleCancel}
            section={cosmeticShopSection}
          />
        )}
      </Stack>
    </Container>
  );
}
