import { Container, Stack, Text, Title } from '@mantine/core';
import { useRouter } from 'next/router';
import * as z from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { CsamGeneratorEvidence } from '~/components/Csam/CsamGeneratorEvidence';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

const idSchema = z.coerce.number().int().positive().max(2_147_483_647);

function GeneratorEvidencePage() {
  const router = useRouter();
  const userId = idSchema.catch(0).parse(router.query.userId);
  const restrictionId = idSchema.optional().catch(undefined).parse(router.query.restrictionId);
  const features = useFeatureFlags();
  const { data: user, isLoading } = trpc.user.getById.useQuery(
    { id: userId },
    { enabled: userId > 0 }
  );

  if (!features.csamReports || !userId) return <NotFound />;
  if (isLoading) return <PageLoader />;

  return (
    <Container size="lg" py="md">
      <Stack>
        <Title order={2}>Generator evidence</Title>
        {user?.username && (
          <Text size="sm">
            User:{' '}
            <Text component={Link} c="blue.4" href={`/user/${user.username}`}>
              {user.username}
            </Text>{' '}
            ({userId})
          </Text>
        )}
        <CsamGeneratorEvidence userId={userId} preselectRestrictionId={restrictionId} />
      </Stack>
    </Container>
  );
}

export const getServerSideProps = createServerSideProps({ requireModerator: true });

export default Page(GeneratorEvidencePage, { footer: null });
