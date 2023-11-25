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
import Link from 'next/link';

const getEntityUrl = ({
  entityType,
  entityId,
}: {
  entityType: SupportedClubEntities;
  entityId: number;
}) => {
  switch (entityType) {
    case 'Model':
      return `/models/${entityId}`;
    case 'Article':
      return `/articles/${entityId}`;
  }
};

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

  if (clubEntity.type === 'membersOnlyNoAccess') {
    // Requires a club membership to view.
    return (
      <Container size="md">
        <Stack>
          <Title order={2}>Welcome to {club.name}</Title>
          <Paper withBorder p="md">
            <AlertWithIcon icon={<IconAlertCircle />} px="xs">
              This model requires a membership to view.
            </AlertWithIcon>
          </Paper>
        </Stack>
      </Container>
    );
  }

  if (clubEntity.type === 'noAccess') {
    // Requires a club membership to view.
    return (
      <Container size="md">
        <Stack>
          <Title order={2}>Welcome to {club.name}</Title>
          <Paper withBorder p="md">
            <Stack>
              <span>TODO: Cover image - display hash only </span>
              <Title order={3}>{clubEntity.title}</Title>
              <RenderHtml html={clubEntity.description} />
              <Button onClick={() => {}}>Unlock this content</Button>
            </Stack>
          </Paper>
        </Stack>
      </Container>
    );
  }

  return (
    <Container size="md">
      <Stack>
        <Title order={2}>Welcome to {club.name}</Title>
        <Paper withBorder p="md">
          <span>TODO: Cover image display</span>
          <Title order={3}>{clubEntity.title}</Title>
          <RenderHtml html={clubEntity.description} />
          <Link href={getEntityUrl({ entityId, entityType })} passHref>
            <Button fullWidth>Checkout this resource</Button>
          </Link>
        </Paper>
      </Stack>
    </Container>
  );
}
