import { Button, Group, Stack, Title, Text, Tabs } from '@mantine/core';
import type { InferGetServerSidePropsType } from 'next';
import * as z from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { useQueryClub } from '~/components/Club/club.utils';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import React from 'react';
import { ClubManagementLayout } from '~/pages-old/clubs/manage/[id]/index';
import { ClubAdminPermission } from '~/shared/utils/prisma/enums';
import { ClubAdminInvitesPaged } from '../../../../components/Club/Infinite/ClubAdminInvitesPaged';
import { dialogStore } from '../../../../components/Dialog/dialogStore';
import { ClubAdminInviteUpsertModal } from '../../../../components/Club/ClubAdminInviteUpsertForm';
import { ClubAdminsPaged } from '../../../../components/Club/Infinite/ClubAdminsPaged';

const querySchema = z.object({ id: z.coerce.number() });

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ session, features, ctx, ssg }) => {
    if (!features?.clubs) return { notFound: true };

    if (!session)
      return {
        redirect: {
          destination: `/login?returnUrl=${encodeURIComponent(ctx.resolvedUrl)}`,
          permanent: false,
        },
      };

    const result = querySchema.safeParse(ctx.params);
    if (!result.success) return { notFound: true };

    const { id } = result.data;
    const club = await dbRead.club.findUnique({
      where: { id },
      select: { userId: true },
    });

    if (!club) return { notFound: true };

    const clubAdmin = await dbRead.clubAdmin.findFirst({
      where: { clubId: id, userId: session.user?.id },
    });

    const isModerator = session.user?.isModerator ?? false;
    const isOwner = club.userId === session.user?.id || isModerator;

    if (!isOwner && !isModerator && !clubAdmin)
      return {
        redirect: {
          destination: `/clubs/${id}`,
          permanent: false,
        },
      };

    if (ssg) {
      await ssg.club.getById.prefetch({ id });
    }

    // return {
    //   redirect: {
    //     destination: '/content/clubs',
    //     permanent: true,
    //   },
    // };

    return { props: { id } };
  },
});

export default function Revenue({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { club, loading } = useQueryClub({ id });

  if (loading) return <PageLoader />;
  if (!club) return <NotFound />;

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>Club Admins</Title>
      </Group>
      <Text>
        You can add admins to your club to help you with administrating it. You are not required in
        any way to do this, but it can be helpful if you have a lot of members.
      </Text>
      <Tabs variant="outline" defaultValue="admins">
        <Tabs.List>
          <Tabs.Tab value="admins">Admins</Tabs.Tab>
          <Tabs.Tab value="pending">Pending invites</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="pending" pt="md">
          <Stack gap="md">
            <Group justify="space-between">
              <Title order={4}>Pending invites</Title>
              <Button
                onClick={() => {
                  dialogStore.trigger({
                    component: ClubAdminInviteUpsertModal,
                    props: {
                      clubId: club.id,
                    },
                  });
                }}
              >
                New invite
              </Button>
            </Group>
            <ClubAdminInvitesPaged clubId={club.id} />
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="admins" pt="md">
          <Stack gap="md">
            <Title order={4}>Active admins</Title>
            <ClubAdminsPaged clubId={club.id} />
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

Revenue.getLayout = function getLayout(page: React.ReactNode) {
  return <ClubManagementLayout>{page}</ClubManagementLayout>;
};
