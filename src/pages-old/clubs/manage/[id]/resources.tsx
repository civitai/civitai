import { Button, Center, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import type { InferGetServerSidePropsType } from 'next';
import * as z from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import {
  useClubContributorStatus,
  useQueryClub,
  useQueryClubMembership,
} from '~/components/Club/club.utils';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import React, { useState } from 'react';
import { trpc } from '~/utils/trpc';
import { IconPlus } from '@tabler/icons-react';
import { ClubManagementLayout } from '~/pages-old/clubs/manage/[id]/index';
import { ClubMembershipInfinite } from '~/components/Club/Infinite/ClubsMembershipInfinite';
import { ClubResourcesPaged } from '~/components/Club/Infinite/ClubResourcesPaged';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { AddResourceToClubModal } from '~/components/Club/AddResourceToClubModal';
import { ClubAdminPermission } from '~/shared/utils/prisma/enums';
import { ClubAddContent } from '../../../../components/Club/ClubAddContent';

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
    const canManageResources =
      clubAdmin?.permissions.includes(ClubAdminPermission.ManageResources) ?? false;

    if (!isOwner && !isModerator && !canManageResources)
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

export default function ManageClubMembers({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { club, loading } = useQueryClub({ id });
  const { isClubAdmin, isOwner } = useClubContributorStatus({ clubId: id });

  if (!loading && !club) return <NotFound />;
  if (loading) return <PageLoader />;

  return (
    <Stack gap="md">
      <Title order={2}>Manage Club Resources</Title>
      <Text>
        You can manage your club resources here. You can manage resource tiers, edit, and delete
        resources. To add new resources, you should go to the resource and use the context menu to{' '}
        <code>Add to club</code> or use the resource&rsquo;s edit form.
      </Text>
      {(isOwner || isClubAdmin) && (
        <Button
          onClick={() => {
            dialogStore.trigger({
              component: ClubAddContent,
              props: {
                clubId: id,
              },
            });
          }}
        >
          Add new resource
        </Button>
      )}
      <ClubResourcesPaged clubId={id} />
    </Stack>
  );
}

ManageClubMembers.getLayout = function getLayout(page: React.ReactNode) {
  return <ClubManagementLayout>{page}</ClubManagementLayout>;
};
