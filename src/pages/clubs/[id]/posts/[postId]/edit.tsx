import { Anchor, Button, Container, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { NotFound } from '~/components/AppLayout/NotFound';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { ModelVersionUpsertForm } from '~/components/Resource/Forms/ModelVersionUpsertForm';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { useClubContributorStatus } from '~/components/Club/club.utils';
import { ClubPostUpsertForm } from '~/components/Club/ClubPost/ClubPostUpsertForm';
import { useClubFeedStyles } from '~/components/Club/ClubPost/ClubFeed';
import { ClubAdminPermission } from '@prisma/client';
import { createServerSideProps } from '../../../../../server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.clubs) return { notFound: true };

    // return {
    //   redirect: {
    //     destination: '/content/clubs',
    //     permanent: false,
    //   },
    // };
  },
});

export default function ClubPostEdit() {
  const router = useRouter();
  const postId = Number(router.query.postId);
  const currentUser = useCurrentUser();
  const { data: clubPost, isLoading } = trpc.clubPost.getById.useQuery({
    id: postId,
  });

  const { isOwner, permissions } = useClubContributorStatus({
    clubId: clubPost?.clubId,
  });
  const { classes } = useClubFeedStyles();

  const isModerator = currentUser?.isModerator ?? false;

  const canUpdatePost =
    isModerator || isOwner || permissions.includes(ClubAdminPermission.ManagePosts);

  if (isLoading) return <PageLoader />;
  if (!canUpdatePost || !clubPost) return <NotFound />;

  const handleClose = () => {
    router.push(`/clubs/${clubPost.clubId}`);
  };

  return (
    <Container size="md">
      <Stack spacing="xl">
        <Link href={`/clubs/${clubPost.clubId}`} passHref shallow>
          <Anchor size="sm">
            <Group spacing={4}>
              <IconArrowLeft size={18} strokeWidth={1.5} />
              <Text inherit>Back to club&rsquo;s page</Text>
            </Group>
          </Anchor>
        </Link>
        <Title order={1}>Edit Club Post</Title>
        <Paper className={classes.feedContainer}>
          <ClubPostUpsertForm
            clubId={clubPost.clubId}
            clubPost={clubPost}
            onSuccess={() => {
              handleClose();
            }}
          />
        </Paper>
      </Stack>
    </Container>
  );
}
