import { Button, Center, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import { InferGetServerSidePropsType } from 'next';
import { z } from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { useQueryClub, useQueryClubMembership } from '~/components/Club/club.utils';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import React, { useState } from 'react';
import { trpc } from '~/utils/trpc';
import { IconPlus } from '@tabler/icons-react';
import { ClubManagementLayout } from '~/pages/clubs/manage/[id]/index';
import { ClubTierUpsertForm } from '~/components/Club/ClubTierUpsertForm';
import { ClubTierManageItem } from '~/components/Club/ClubTierManageItem';
import { useClubFeedStyles } from '~/components/Club/ClubFeed';
import { GetInfiniteClubMembershipsSchema } from '~/server/schema/clubMembership.schema';
import { ClubMembershipSort } from '~/server/common/enums';
import { ClubMembershipInfinite } from '~/components/Club/Infinite/ClubsMembershipInfinite';

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

    const isModerator = session.user?.isModerator ?? false;
    const isOwner = club.userId === session.user?.id || isModerator;
    if (!isOwner && !isModerator)
      return {
        redirect: {
          destination: `/clubs/${id}`,
          permanent: false,
        },
      };

    if (ssg) {
      await ssg.club.getById.prefetch({ id });
      await ssg.club.getTiers.prefetch({
        clubId: id,
        include: ['membershipsCount'],
      });
    }

    return { props: { id } };
  },
});

export default function ManageClubMembers({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { club, loading } = useQueryClub({ id });

  if (!loading && !club) return <NotFound />;
  if (loading) return <PageLoader />;

  return (
    <Stack spacing="md">
      <Title order={2}>Manage Members</Title>
      <Text>
        You can see who has joined your club, how long they&apos;ve been a member, and the club tier
        they&apos;re in.
      </Text>
      <ClubMembershipInfinite clubId={id} />
    </Stack>
  );
}

ManageClubMembers.getLayout = function getLayout(page: React.ReactNode) {
  return <ClubManagementLayout>{page}</ClubManagementLayout>;
};
