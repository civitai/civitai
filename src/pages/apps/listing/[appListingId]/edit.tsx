import { Anchor, Center, Group, Loader, Stack, Tabs } from '@mantine/core';
import {
  IconArrowLeft,
  IconCoin,
  IconHistory,
  IconPhoto,
  IconRocket,
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
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { APPS_PAGE_MEASURES } from '~/components/Apps/appsPageWidths';
import { ListingHistoryPanel } from '~/components/Apps/ListingHistoryPanel';
import { ListingPublishingPanel } from '~/components/Apps/ListingPublishingPanel';
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
 * status, capabilities)`. Rendering a tab whose query will 403/404 is the failure mode this
 * page exists to avoid, so the allowed set and the `?tab=` parse both come from one function
 * and an out-of-set `?tab=` falls back rather than mounting a doomed panel.
 *
 * 🔴 AND THE SET IS NOW STATUS-KEYED, WHICH MAKES IT A SECURITY SURFACE. This route used to
 * refuse a `removed` or `rejected` listing outright, because leaving it open left a LIVE
 * Collaborators tab on a delisted app and accepting an invite there still mints Forgejo
 * `write`. That refusal also put an owner's own Republish out of reach — an owner Unpublish
 * writes the same `status='removed'` a moderator takedown does — i.e. a one-way door only a
 * moderator could reopen. The route now opens in a NARROWED mode instead: at most Publishing
 * (owner) + History, with every content tab withheld. The Collaborators hazard is closed at
 * its own enforcement point (`inviteCollaborator` / `respondToInvite` refuse a non-authorable
 * listing), because a tab set is a UI narrowing and never a gate.
 *
 * 🔴 AND THE SET NOW ALSO READS `lastModerationAction`, because `status` alone cannot answer
 * the question on `removed`. civitai/civitai#4413 taught the SERVER to tell an owner
 * self-unpublish from a moderator takedown and to accept repair edits on the former; this
 * page is what makes that reachable. An owner-unpublished listing regains Details + Media
 * (each rendered in a repair-aware mode — see `ExternalListingEditForm`'s locked material
 * fields and `ListingMediaEditor`'s unpublished frame); a moderator-delisted one still gets
 * the narrowed set, and `AUTHORABLE_LISTING_STATUSES` is deliberately NOT widened, because
 * its other consumer is the server gate on collaborator invites.
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
  publishing: IconRocket,
  history: IconHistory,
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
      <AppsPageLayout measure={APPS_PAGE_MEASURES['/apps/listing/[appListingId]/edit']}>
        <Center py="xl">
          <Loader />
        </Center>
      </AppsPageLayout>
    );
  }

  const tabs = editorTabsFor({
    kind: context.kind,
    appBlockId: context.appBlockId,
    role: context.role,
    // 🔴 THE SECURITY INPUT. A non-authorable listing (`removed`/`rejected`) collapses the
    // set to at most Publishing + History — no Details, and above all no Collaborators.
    // See `editorTabsFor`; the page must never hardcode a tab past this derivation.
    status: context.status,
    // 🔴 THE SECOND HALF OF THAT INPUT, and without it `status` cannot answer the question.
    // `removed` is written by BOTH an owner self-unpublish and a moderator takedown; the
    // server (civitai/civitai#4413) lets the owner repair the FIRST and still refuses the
    // second, so the tab set has to read the same bit or the page offers a surface the
    // procs refuse (or withholds one they accept). Arrives NORMALISED
    // (`owner-unpublish` | `other` | null) — a seated editor never receives a moderator's
    // actual verb. Same field the Publishing tab already branches on, two panels down.
    lastModerationAction: context.lastModerationAction,
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
      <AppsPageLayout measure={APPS_PAGE_MEASURES['/apps/listing/[appListingId]/edit']}>
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

            {/* 🔴 `context.appBlockId` is non-null whenever this tab is in the set — THIS
                PANEL is block-keyed (it passes an `appBlockId` down), which is exactly why
                `editorTabsFor` withholds the tab without one. Note the host resolver is
                NOT the constraint any more: `getMyListingForApp` takes `appBlockId` OR
                `slug` since civitai/civitai#3984. Re-keying this panel onto the slug is
                civitai/civitai#3893. */}
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

            {/* 🔴 OWNER-ONLY AND STATUS-KEYED — `editorTabsFor` offers this tab only where a
                publishing control actually exists (`approved` ⇒ Unpublish, `removed` ⇒
                Republish) and only to the owner, because both procs are owner-scoped
                server-side. It is the tab that makes an owner Unpublish reversible. */}
            {tabs.includes('publishing') ? (
              <Tabs.Panel value="publishing" pt="md" data-testid="apps-edit-panel-publishing">
                <ListingPublishingPanel
                  appListingId={context.appListingId}
                  slug={context.slug}
                  kind={context.kind}
                  role={context.role}
                  status={context.status}
                  lastModerationAction={context.lastModerationAction}
                />
              </Tabs.Panel>
            ) : null}

            {/* Moved off the `/apps/mine` row — see `ListingHistoryPanel`'s header for what
                that move could have stranded and why it does not. */}
            {tabs.includes('history') ? (
              <Tabs.Panel value="history" pt="md" data-testid="apps-edit-panel-history">
                <ListingHistoryPanel appListingId={context.appListingId} />
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
      </AppsPageLayout>
    </>
  );
}
