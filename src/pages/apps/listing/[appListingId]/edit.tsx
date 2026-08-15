import { Anchor, Center, Container, Group, Loader, Stack, Tabs } from '@mantine/core';
import {
  IconArrowLeft,
  IconCoin,
  IconPhoto,
  IconSettings,
  IconUsers,
  IconWriting,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';

import { NotFound } from '~/components/AppLayout/NotFound';
import { AppCollaboratorsPanel } from '~/components/Apps/AppCollaboratorsPanel';
import { AppEarningsPanel } from '~/components/Apps/AppEarningsPanel';
import type { EditorTab } from '~/components/Apps/appListingEditorTabs';
import {
  EDITOR_TAB_LABELS,
  editorTabsFor,
  listingEditHref,
  resolveEditorTab,
} from '~/components/Apps/appListingEditorTabs';
import { APPS_PAGE_WIDTHS } from '~/components/Apps/appsPageWidths';
import { AppsListingDetailsEditor } from '~/components/Apps/AppsSubmitEditView';
import { goBackOrFallback } from '~/components/Apps/listingEditNav';
import { ListingMediaEditor } from '~/components/Apps/ListingMediaEditor';
import { ManifestEditForm } from '~/components/Apps/ManifestEditForm';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { AppListingAuthoringContext } from '~/server/services/blocks/app-access.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

/**
 * `/apps/listing/<appListingId>/edit` — THE canonical owner/editor authoring page.
 *
 * 🔴 LISTING-KEYED, and that is the whole point. Seats key to `AppListing`, and an
 * OFF-SITE listing has no AppBlock at all, so the previous block-keyed route
 * (`/apps/<appBlockId>/edit`) was structurally unable to address one of the store's two
 * kinds. That route now 302s here whenever its block has a listing, `?tab=` preserved.
 *
 * 🔴 THE TAB SET IS DERIVED, NEVER HARDCODED — `editorTabsFor(kind, appBlockId, role,
 * capabilities)`. Rendering a tab whose query will 403/404 is the failure mode this page
 * exists to avoid, so the allowed set and the `?tab=` parse both come from one function
 * and an out-of-set `?tab=` falls back rather than mounting a doomed panel.
 *
 * Access is single-sourced at the tRPC layer: `appListings.getAuthoringContext` resolves
 * the caller's role (owner OR accepted editor) and throws FORBIDDEN/NOT_FOUND otherwise
 * — both settle to `NotFound` here, which is the established non-enumerable posture.
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

const TAB_ICONS: Record<EditorTab, typeof IconSettings> = {
  details: IconWriting,
  media: IconPhoto,
  manifest: IconSettings,
  earnings: IconCoin,
  collaborators: IconUsers,
};

/**
 * 🔴 DERIVED FROM THE SERVER'S OWN RETURN TYPE, not hand-written alongside it.
 *
 * This was a duplicated structural type, and the `data as AuthoringContext` cast below
 * made the duplication INVISIBLE to `tsc`: dropping a field from the service — the exact
 * shape of the original defect — left the page compiling cleanly against its own stale
 * copy, and a later RENAME would have been applied to the service and its tests while this
 * page silently kept reading the old key. A type-only import costs nothing at runtime (it
 * is erased) and is the established pattern here; the cast is now checked against the
 * thing it is casting from.
 */
type AuthoringContext = AppListingAuthoringContext;

/** The manifest tab's body. Its own query, so it costs nothing on the other tabs. */
function ManifestTabPanel({ appBlockId }: { appBlockId: string }) {
  const { data, isLoading } = trpc.blocks.getMyAppManifest.useQuery(
    { appBlockId },
    { retry: false }
  );
  if (isLoading || !data) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  return (
    <ManifestEditForm
      appBlockId={data.appBlockId}
      slug={data.slug}
      currentVersion={data.version}
      manifest={data.manifest}
    />
  );
}

export default function AppListingEditPage() {
  const features = useFeatureFlags();
  const router = useRouter();
  const appListingId =
    typeof router.query.appListingId === 'string' ? router.query.appListingId : '';

  const { data, isLoading, error } = trpc.appListings.getAuthoringContext.useQuery(
    { appListingId },
    { enabled: !!features.appBlocks && !!appListingId, retry: false }
  );
  const context = data as AuthoringContext | undefined;

  if (!features.appBlocks) return <NotFound />;
  // FORBIDDEN (no role) / NOT_FOUND both settle to NotFound (retry:false).
  if (error) return <NotFound />;

  if (isLoading || !context) {
    return (
      <Container size={APPS_PAGE_WIDTHS['/apps/listing/[appListingId]/edit']} py="md">
        <Center py="xl">
          <Loader />
        </Center>
      </Container>
    );
  }

  const tabs = editorTabsFor({
    kind: context.kind,
    appBlockId: context.appBlockId,
    role: context.role,
    capabilities: context.capabilities,
  });
  const tab = resolveEditorTab(router.query.tab, tabs);

  function selectTab(next: string | null) {
    const nextTab = resolveEditorTab(next, tabs);
    void router.replace(listingEditHref(appListingId, nextTab), undefined, { shallow: true });
  }

  return (
    <>
      <Meta title={`Edit ${context.name} — Civitai Apps`} deIndex />
      <Container size={APPS_PAGE_WIDTHS['/apps/listing/[appListingId]/edit']} py="md">
        <Stack gap="lg">
          <Anchor
            component="button"
            type="button"
            size="sm"
            onClick={() => goBackOrFallback(router, '/apps/mine')}
            data-testid="apps-edit-back"
          >
            <Group gap={4}>
              <IconArrowLeft size={14} />
              Back
            </Group>
          </Anchor>

          <Tabs value={tab} onChange={selectTab} keepMounted={false}>
            <Tabs.List>
              {tabs.map((value) => {
                const Icon = TAB_ICONS[value];
                return (
                  <Tabs.Tab
                    key={value}
                    value={value}
                    leftSection={<Icon size={14} />}
                    data-testid={`apps-edit-tab-${value}`}
                  >
                    {EDITOR_TAB_LABELS[value]}
                  </Tabs.Tab>
                );
              })}
            </Tabs.List>

            {tabs.includes('details') ? (
              <Tabs.Panel value="details" pt="md" data-testid="apps-edit-panel-details">
                <AppsListingDetailsEditor listingId={context.appListingId} />
              </Tabs.Panel>
            ) : null}

            {/* 🔴 `context.appBlockId` is non-null whenever this tab is in the set — the
                media editor is hosted by the BLOCK-keyed `getMyListingForApp`, which is
                exactly why `editorTabsFor` withholds the tab without one. */}
            {tabs.includes('media') && context.appBlockId ? (
              <Tabs.Panel value="media" pt="md" data-testid="apps-edit-panel-media">
                <ListingMediaEditor appBlockId={context.appBlockId} />
              </Tabs.Panel>
            ) : null}

            {tabs.includes('manifest') && context.appBlockId ? (
              <Tabs.Panel value="manifest" pt="md" data-testid="apps-edit-panel-manifest">
                <ManifestTabPanel appBlockId={context.appBlockId} />
              </Tabs.Panel>
            ) : null}

            {/* 🔴 Keyed on the LISTING, like the proc. `getAppEarnings` resolves the
                caller's role itself and refuses an off-site listing, so the tab set (which
                mirrors that refusal) and the panel agree by construction. */}
            {tabs.includes('earnings') ? (
              <Tabs.Panel value="earnings" pt="md" data-testid="apps-edit-panel-earnings">
                <AppEarningsPanel appListingId={context.appListingId} />
              </Tabs.Panel>
            ) : null}

            {tabs.includes('collaborators') ? (
              <Tabs.Panel value="collaborators" pt="md" data-testid="apps-edit-panel-collaborators">
                <AppCollaboratorsPanel
                  appListingId={context.appListingId}
                  role={context.role}
                  capabilities={context.capabilities}
                  // 🔴 The two facts the transfer verdict is made of, straight off the
                  // authoring context. Ownership of a connect-linked off-site listing can
                  // never move, and the tab has to be able to say so BEFORE the owner
                  // picks a recipient — see `refusesTransferForConnectClient`.
                  listing={{ kind: context.kind, connectClientId: context.connectClientId }}
                />
              </Tabs.Panel>
            ) : null}
          </Tabs>
        </Stack>
      </Container>
    </>
  );
}
