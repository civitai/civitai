import { Anchor, Center, Group, Loader, Stack, Tabs } from '@mantine/core';
import { IconArrowLeft, IconPhoto, IconSettings } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { APPS_PAGE_MEASURES } from '~/components/Apps/appsPageWidths';
import { ListingMediaEditor } from '~/components/Apps/ListingMediaEditor';
import { ManifestEditForm } from '~/components/Apps/ManifestEditForm';
import { ALL_EDITOR_TABS } from '~/components/Apps/appListingEditorTabs';
import { canonicalEditRedirect, goBackOrFallback } from '~/components/Apps/listingEditNav';
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
    // 🔴 302 TO THE CANONICAL LISTING-KEYED PAGE when this block HAS a listing,
    // preserving `?tab=`. `/apps/listing/<appListingId>/edit` serves BOTH store kinds;
    // this block-keyed route structurally cannot address an off-site listing, so it
    // stops being the canonical authoring URL here.
    //
    // 🔴 IT MUST NOT REDIRECT UNCONDITIONALLY — a block whose first version is still
    // pending approval has no `AppListing` row, hence no canonical URL, and an
    // unconditional 302 would loop it onto itself. `canonicalEditRedirect` returns
    // `{ props: {} }` for that case and the legacy page below renders as it always did.
    const raw = ctx.params?.appBlockId;
    const appBlockId = Array.isArray(raw) ? raw[0] : raw;
    const appListingId = appBlockId
      ? await (
          await import('~/server/services/blocks/app-access.service')
        ).listingIdForAppBlock(appBlockId)
      : null;
    return canonicalEditRedirect(raw, ctx.query?.tab, appListingId, ALL_EDITOR_TABS);
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
      {/*
        🔴 THIS PAGE'S GATE DOES NOT IMPLY THE SUB-NAV'S — one of three adopted pages
        where that is true. The `getServerSideProps` above gates on `appBlocks` ALONE,
        with no author requirement, while `AppsSubNav` hides itself entirely below TWO
        qualifying tabs. Only "Marketplace" is unconditional; every other tab needs an
        author capability, an install, an approved app, a pending invite or reviewer
        status. So a viewer granted `app-blocks-enabled` in Flipt who is not a moderator,
        not an author, and holds none of those — a seated collaborator on someone else's
        listing is the realistic shape — reaches this page, qualifies for one tab, and
        gets an EMPTY chrome band: the `Stack gap="xl"` above the body and nothing else.

        Not a live defect (pre-GA the flag resolves for mods, who are authors), and not a
        correctness problem when it does happen — it is 32px of dead space, not a broken
        page. Recorded because the trigger is a RUNTIME Flipt toggle rather than a deploy:
        `appBlocks` is `{ availability: ['mod'], fliptKey: 'app-blocks-enabled' }` and
        `getFeatureFlags` returns the Flipt answer before it evaluates `availability`, so
        this widens with no code change and no PR. See the fuller note in
        `src/pages/apps/get-started.tsx`.
      */}
      <AppsPageLayout measure={APPS_PAGE_MEASURES['/apps/[appBlockId]/edit']}>
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
      </AppsPageLayout>
    </>
  );
}
