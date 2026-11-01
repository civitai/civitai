import { Anchor, Center, Container, Loader, Stack, Text, Title } from '@mantine/core';
import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import type { HatFitChanges } from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import { HatFitEditor } from '~/components/Cosmetics/EventDecoration/HatFitEditor';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '~/components/NextLink/NextLink';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isEventDecorationData } from '~/shared/constants/event-decoration.constants';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({ requireModerator: true });

export default function CosmeticEditPage() {
  const router = useRouter();
  const id = Number(router.query.id);
  const queryUtils = trpc.useUtils();
  const { data: cosmetic, isLoading } = trpc.cosmetic.getById.useQuery(
    { id },
    { enabled: Number.isInteger(id) && id > 0 }
  );
  const saveFit = trpc.cosmetic.updateEventHatFit.useMutation({
    async onSuccess(saved) {
      // getById reads a replica, which may not have the save yet.
      queryUtils.cosmetic.getById.setData({ id }, (current) =>
        current ? { ...current, data: saved.data as typeof current.data } : current
      );
      await queryUtils.cosmetic.getPaged.invalidate();
      showSuccessNotification({ message: 'Saved. Cards wearing this hat show it now.' });
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not save the hat', error: new Error(error.message) }),
  });

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (!cosmetic) return <NotFound />;

  const hat =
    isEventDecorationData(cosmetic.data) && cosmetic.data.type === 'hat' ? cosmetic.data : null;

  return (
    <>
      <Meta title={`Edit ${cosmetic.name}`} deIndex />
      <Container size="lg">
        <Stack gap="lg">
          <Stack gap={0}>
            <Anchor component={NextLink} href="/moderator/cosmetic-store/cosmetics" size="sm">
              All cosmetics
            </Anchor>
            <Title order={1}>{cosmetic.name}</Title>
            <Text size="sm" c="dimmed">
              {cosmetic.type}
              {hat && ` · ${hat.event}${hat.team ? ` · ${hat.team}` : ''}`}
            </Text>
          </Stack>
          {hat ? (
            <HatFitEditor
              // Remount after a save so the editor starts again from what was stored.
              key={JSON.stringify(hat.fit ?? {})}
              hat={hat}
              saving={saveFit.isPending}
              onSave={(fit: HatFitChanges) => saveFit.mutate({ id, fit })}
            />
          ) : (
            <Text>Only event hats can be edited here so far.</Text>
          )}
        </Stack>
      </Container>
    </>
  );
}
