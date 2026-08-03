import { Anchor, Badge, Container, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { NotFound } from '~/components/AppLayout/NotFound';
import { RevenuePanel } from '~/components/AppBlocks/RevenuePanel';
import { APPS_PAGE_WIDTHS } from '~/components/Apps/appsPageWidths';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isAppDeveloper } from '~/shared/utils/app-blocks-access';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    // Author-capability gate (Phase B): the dedicated `appBlocksAuthor` flag
    // (Flipt `app-blocks-author`, static fallback mod-only), INDEPENDENT of the
    // marketplace-visibility `appBlocks` flag (which widens to public at GA).
    if (!features?.appBlocksAuthor) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
    }
    if (!isAppDeveloper(session.user, { appBlocksAuthor: features?.appBlocksAuthor })) {
      return { notFound: true };
    }
    return { props: {} };
  },
});

type AppRow = {
  id: string;
  appName: string | null;
};

export default function AppRevenuePage() {
  const features = useFeatureFlags();
  const router = useRouter();
  const appBlockId = typeof router.query.appBlockId === 'string' ? router.query.appBlockId : '';

  if (!features.appBlocks) return <NotFound />;

  // The app's metadata, looked up via getMyApps for the owner-check side effect
  // — if the user isn't the app owner the app won't appear in the list and we
  // render notFound. The revenue read itself lives in <RevenuePanel>, which is
  // shared with /apps/revenue so the fabricated-zero guard has a single home.
  const myAppsQuery = trpc.blocks.getMyApps.useQuery(undefined, { enabled: !!appBlockId });

  const myAppsData = myAppsQuery.data as AppRow[] | undefined;
  const thisApp = myAppsData?.find((a) => a.id === appBlockId);
  const ownerCheckDone = !myAppsQuery.isLoading && myAppsData !== undefined;
  // After the owner query lands, if the app isn't in the owner list we fail
  // closed — even if a non-owner guesses the route. Server-side service
  // filtering already prevents data leakage, but the UI notFound makes the
  // intent explicit.
  if (ownerCheckDone && !thisApp) {
    return <NotFound />;
  }

  return (
    <>
      <Meta title={`Revenue — ${thisApp?.appName ?? appBlockId}`} deIndex />
      <Container size={APPS_PAGE_WIDTHS['/apps/[appBlockId]/revenue']} py="xl">
        <Stack gap="lg">
          <div>
            <Group gap="xs" align="baseline">
              <Title order={2}>{thisApp?.appName ?? appBlockId}</Title>
              <Badge variant="light" color="green" size="sm">
                Owned by you
              </Badge>
            </Group>
            <Text c="dimmed" size="sm">
              <Anchor component={Link} href="/apps/revenue">
                ← All apps
              </Anchor>
            </Text>
          </div>

          {myAppsQuery.isLoading ? (
            <Group justify="center" py="xl">
              <Loader />
            </Group>
          ) : (
            <RevenuePanel appBlockId={appBlockId} />
          )}
        </Stack>
      </Container>
    </>
  );
}
