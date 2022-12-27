import { Container, Grid, Title } from '@mantine/core';
import { GetServerSideProps, InferGetServerSidePropsType } from 'next';
import { useRouter } from 'next/router';
import { BountyForm } from '~/components/BountyForm/BountyForm';
import { getEdgeUrl } from '~/components/EdgeImage/EdgeImage';
import { Meta } from '~/components/Meta/Meta';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { useCurrentUser } from '~/hooks/useCurrentUser';

import { getServerProxySSGHelpers } from '~/server/utils/getServerProxySSGHelpers';
import { removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isNumber } from '~/utils/type-guards';

export const getServerSideProps: GetServerSideProps<
  { id: number; slug: string },
  { id: string; slug: string }
> = async (context) => {
  const { id, slug } = context.params ?? { id: '', slug: '' };
  if (!id || !isNumber(id)) return { notFound: true };

  const bountyId = Number(id);
  const ssg = await getServerProxySSGHelpers(context);
  await ssg.bounty.getById.prefetch({ id: bountyId });

  return {
    props: {
      trpcState: ssg.dehydrate(),
      id: bountyId,
      slug,
    },
  };
};

export default function BountyDetails(
  props: InferGetServerSidePropsType<typeof getServerSideProps>
) {
  const router = useRouter();
  const currentUser = useCurrentUser();

  const { id } = props;
  const { edit, showNsfw } = router.query;

  const { data: bounty } = trpc.bounty.getById.useQuery({ id });

  const isModerator = currentUser?.isModerator ?? false;
  const isOwner = bounty?.user.id === currentUser?.id || isModerator;
  const showNsfwRequested = showNsfw !== 'true';
  const userNotBlurringNsfw = currentUser?.blurNsfw !== false;
  const nsfw = userNotBlurringNsfw && showNsfwRequested && bounty?.nsfw === true;
  const [coverImage] = bounty?.images ?? [];

  if (!!edit && bounty && isOwner) return <BountyForm bounty={bounty} />;

  return (
    <>
      <Meta
        title={`${bounty?.name} | Civitai`}
        description={removeTags(bounty?.description ?? '')}
        image={nsfw || !coverImage?.url ? undefined : getEdgeUrl(coverImage?.url, { width: 1200 })}
      />
      <Container size="xl">
        <Grid gutter="xl">
          <Grid.Col span={12}>
            <Title order={1}>{bounty?.name}</Title>
          </Grid.Col>
          <Grid.Col span={12}>
            <RenderHtml html={bounty?.description ?? ''} />
          </Grid.Col>
        </Grid>
      </Container>
    </>
  );
}
