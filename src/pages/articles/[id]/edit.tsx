import { Center, Container, Group, Loader, Stack, Title } from '@mantine/core';
import { InferGetServerSidePropsType } from 'next';
import React from 'react';
import { z } from 'zod';

import { ArticleUpsertForm } from '~/components/Article/ArticleUpsertForm';
import { BackButton } from '~/components/BackButton/BackButton';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

const querySchema = z.object({ id: z.number() });

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
    if (session.user?.muted) return { notFound: true };

    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };

    const { id } = result.data;
    const article = await dbRead.article.findUnique({ where: { id }, select: { userId: true } });
    if (!article) return { notFound: true };

    const isOwner = article.userId === session.user?.id || session.user?.isModerator;
    if (!isOwner) return { notFound: true };

    return { props: { id } };
  },
});

export default function ArticleEditPage({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { data, isLoading } = trpc.article.getById.useQuery({ id });

  return (
    <Container size="lg">
      <Stack spacing="xl">
        <Group spacing={4}>
          <BackButton url={`/articles/${id}`} />
          <Title>Editing Article</Title>
        </Group>
        {isLoading && !data ? (
          <Center p="xl">
            <Loader size="lg" />
          </Center>
        ) : (
          <ArticleUpsertForm article={data} />
        )}
      </Stack>
    </Container>
  );
}
