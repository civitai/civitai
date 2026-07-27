import { Anchor, Center, Container, Group, Loader, Stack, Tabs } from '@mantine/core';
import { IconArrowLeft, IconPhoto, IconSettings } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ListingMediaEditor } from '~/components/Apps/ListingMediaEditor';
import { ManifestEditForm } from '~/components/Apps/ManifestEditForm';
import { goBackOrFallback } from '~/components/Apps/listingEditNav';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

/**
 * App management — the UNIFIED owner editor at `/apps/<appBlockId>/edit`.
 *
 * A single tabbed page merging the two former standalone owner surfaces:
 *   - "App / Manifest" (`?tab=manifest`, default) — the `ManifestEditForm` body
 *     (scopes / hide-slots), formerly at `/apps/<appBlockId>/edit-manifest`.
 *   - "Listing media"  (`?tab=media`)             — the `ListingMediaEditor` body
 *     (icon / cover / screenshots), formerly at `/apps/<appBlockId>/listing`.
 *
 * Both old routes now `getServerSideProps`-redirect here (?tab=manifest / ?tab=media)
 * so no deep-link breaks. Owner gating is single-sourced at the tRPC layer:
 * `getMyAppManifest` throws FORBIDDEN (non-owner) / NOT_FOUND → NotFound. Off-site
 * apps are unaffected (their edit is the `/apps/submit?edit=<listingId>` wizard).
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

type EditTab = 'manifest' | 'media';

function resolveTab(value: unknown): EditTab {
  return value === 'media' ? 'media' : 'manifest';
}

export default function AppEditPage() {
  const features = useFeatureFlags();
  const router = useRouter();
  const appBlockId = typeof router.query.appBlockId === 'string' ? router.query.appBlockId : '';
  const tab = resolveTab(router.query.tab);

  // Owner-gated primary read (drives the manifest tab AND the page-level owner gate).
  const { data, isLoading, error } = trpc.blocks.getMyAppManifest.useQuery(
    { appBlockId },
    { enabled: !!features.appBlocks && !!appBlockId, retry: false }
  );

  if (!features.appBlocks) return <NotFound />;
  // FORBIDDEN (non-owner) / NOT_FOUND both settle to NotFound (retry:false).
  if (error) return <NotFound />;

  function selectTab(next: string | null) {
    const nextTab = resolveTab(next);
    void router.replace(
      { pathname: `/apps/${encodeURIComponent(appBlockId)}/edit`, query: { tab: nextTab } },
      undefined,
      { shallow: true }
    );
  }

  return (
    <>
      <Meta title="Edit app — Civitai Apps" deIndex />
      <Container size="sm" py="md">
        <Stack gap="lg">
          {/* Item 3: history-aware back — pop history when there's any, else fall
              back to the app details page (the media editor is now a TAB here, so
              backing out of /edit goes to app details, not another edit view). */}
          <Anchor
            component="button"
            type="button"
            size="sm"
            onClick={() => goBackOrFallback(router, `/apps/${appBlockId}`)}
            data-testid="apps-edit-back"
          >
            <Group gap={4}>
              <IconArrowLeft size={14} />
              Back
            </Group>
          </Anchor>

          <Tabs value={tab} onChange={selectTab} keepMounted={false}>
            <Tabs.List>
              <Tabs.Tab
                value="manifest"
                leftSection={<IconSettings size={14} />}
                data-testid="apps-edit-tab-manifest"
              >
                App / Manifest
              </Tabs.Tab>
              <Tabs.Tab
                value="media"
                leftSection={<IconPhoto size={14} />}
                data-testid="apps-edit-tab-media"
              >
                Listing media
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="manifest" pt="md" data-testid="apps-edit-panel-manifest">
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
            </Tabs.Panel>

            <Tabs.Panel value="media" pt="md" data-testid="apps-edit-panel-media">
              {appBlockId ? (
                <ListingMediaEditor appBlockId={appBlockId} />
              ) : (
                <Center py="xl">
                  <Loader />
                </Center>
              )}
            </Tabs.Panel>
          </Tabs>
        </Stack>
      </Container>
    </>
  );
}
