import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { z } from 'zod';
import { InferGetServerSidePropsType } from 'next';
import { useQueryClub } from '~/components/Club/club.utils';
import { NotFound } from '~/components/AppLayout/NotFound';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Button, Container, Paper, Stack, Title } from '@mantine/core';
import { ClubUpsertForm } from '~/components/Club/ClubUpsertForm';
import React from 'react';
import { trpc } from '~/utils/trpc';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { IconAlertCircle } from '@tabler/icons-react';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { SupportedClubEntities } from '~/server/schema/club.schema';
import { capitalize } from 'lodash-es';
import { ClubEntityItem } from '~/components/Club/ClubEntityItem';

const querySchema = z.object({
  id: z.coerce.number(),
  entityType: z.enum(['model', 'article']).transform((v) => capitalize(v)),
  entityId: z.coerce.number(),
});

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ features, ctx, ssg }) => {
    if (!features?.clubs) return { notFound: true };

    const result = querySchema.safeParse(ctx.params);
    if (!result.success) return { notFound: true };

    const { id, entityId, entityType } = result.data;

    if (ssg) {
      await ssg.club.getById.prefetch({ id });
      await ssg.club.getClubEntity.prefetch({
        entityType: entityType as SupportedClubEntities,
        entityId: entityId,
        clubId: id,
      });
    }

    return { props: { id, entityId, entityType: entityType as SupportedClubEntities } };
  },
});

export default function ClubModelEntity({
  id,
  entityId,
  entityType,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { club, loading } = useQueryClub({ id });
  const { data: clubEntity, isLoading } = trpc.club.getClubEntity.useQuery({
    entityType,
    entityId,
    clubId: id,
  });

  if (loading || isLoading) return <PageLoader />;
  if (!club || !clubEntity) return <NotFound />;

  // Requires a club membership to view.
  return (
    <Container size="md">
      <Stack>
        <Title order={2}>Welcome to {club.name}</Title>
        <ClubEntityItem clubEntity={clubEntity} />
      </Stack>
    </Container>
  );
}
