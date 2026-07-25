import { Anchor, Center, Container, Group, Loader, Stack } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ManifestEditForm } from '~/components/Apps/ManifestEditForm';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

/**
 * App management (Phase 1) — owner-only web manifest editor at
 * `/apps/<appBlockId>/edit-manifest`.
 *
 * Gating: the SSR resolver enforces the appBlocks flag + a logged-in session
 * (an anon caller is bounced to /login). The OWNER check is enforced at the
 * tRPC layer — `getMyAppManifest` (and `updateManifest`) throw FORBIDDEN for a
 * non-owner — so this page surfaces NotFound when the query errors. Single-
 * sourcing the owner gate server-side avoids drift between the SSR check and the
 * mutation check.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.appBlocks) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: { destination: getLoginLink({ returnUrl: ctx.resolvedUrl }), permanent: false },
      };
    }
    return { props: {} };
  },
});

export default function EditManifestPage() {
  const features = useFeatureFlags();
  const router = useRouter();
  const appBlockId = typeof router.query.appBlockId === 'string' ? router.query.appBlockId : '';

  const { data, isLoading, error } = trpc.blocks.getMyAppManifest.useQuery(
    { appBlockId },
    { enabled: !!features.appBlocks && !!appBlockId, retry: false }
  );

  if (!features.appBlocks) return <NotFound />;
  // FORBIDDEN (non-owner) / NOT_FOUND both settle to NotFound (retry:false).
  if (error) return <NotFound />;

  return (
    <>
      <Meta title="Edit app manifest — Civitai Apps" deIndex />
      <Container size="sm" py="md">
        <Stack gap="lg">
          <Anchor component={Link} href={`/apps/${appBlockId}`} size="sm">
            <Group gap={4}>
              <IconArrowLeft size={14} />
              Back to app
            </Group>
          </Anchor>

          {isLoading || !data ? (
            <Center py="xl">
              <Loader />
            </Center>
          ) : (
            <ManifestEditForm
              appBlockId={data.appBlockId}
              slug={data.slug}
              currentVersion={data.version}
              manifest={data.manifest}
            />
          )}
        </Stack>
      </Container>
    </>
  );
}
