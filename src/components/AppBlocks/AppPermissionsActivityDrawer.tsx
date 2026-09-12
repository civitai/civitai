import { Center, Divider, Drawer, Group, Loader, Stack, Text } from '@mantine/core';
import { IconShieldLock } from '@tabler/icons-react';
import { BlockScopeList } from '~/components/Apps/BlockScopeList';
import { AppActivityPanel } from '~/components/Apps/AppActivityPanel';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

/**
 * Run-frame "Permissions & activity" surface — a per-app transparency panel
 * opened from the App Block host chrome (`AppBlockChrome` ⋯ menu). Scoped to a
 * SINGLE app (`appBlockId`), it shows the viewer:
 *
 *   1. The JWT scopes they've granted THIS app (`blocks.listMyScopeGrants`,
 *      filtered to this app, rendered via the shared `BlockScopeList` — the same
 *      component the /apps/activity "Apps & permissions" tab uses).
 *   2. A per-app action audit timeline (`AppActivityPanel` with the `appBlockId`
 *      drill-down — Buzz attribution + scope-gated call audit interleaved).
 *
 * VIEWER-SCOPED: both feeds are the current viewer's OWN data. The run page is a
 * stateless page-mint that anonymous viewers can open, so we gate the (protected)
 * queries on an authenticated session and render a friendly empty state for anon.
 *
 * The body (with its query hooks) only mounts while the drawer is `opened` — so
 * the parent chrome can render this on every run-frame without firing the queries
 * until the user actually opens the panel. (Also keeps `AppBlockChrome`'s own
 * component tests network-free: a closed drawer calls no tRPC hooks.)
 *
 * 🔴 THE FEED'S `App` COLUMN IS PLAIN TEXT HERE, NOT A STORE LINK, AND THAT IS A DECISION
 * RATHER THAN AN OMISSION. `AppActivityPanel` gained a link from the app name to
 * `/apps/store-preview/<slug>`; this drawer is mounted OVER A RUNNING FULL-PAGE APP, so
 * that link would be a TOP-LEVEL navigation out of whatever the user was doing inside it
 * — triggered from a panel they opened to read, with no warning and no way back to their
 * in-app state. The panel suppresses it whenever it is in per-app drill-down mode
 * (`linkable={!appBlockId}`), which is exactly the mode this drawer uses; the column is a
 * label there anyway, since every row is the same app. Not a `target="_blank"`: a second
 * rendering of one column is how the two come to disagree. Pinned by
 * `AppPermissionsActivityDrawer.browser.test.tsx`.
 */
export function AppPermissionsActivityDrawer({
  appBlockId,
  appName,
  opened,
  onClose,
}: {
  appBlockId: string;
  appName?: string;
  opened: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="md"
      title={
        <Group gap="xs" wrap="nowrap">
          <IconShieldLock size={18} stroke={1.5} />
          <Text fw={600}>Permissions &amp; activity</Text>
        </Group>
      }
      data-testid="app-permissions-activity-drawer"
    >
      {/* Mount the query-bearing body only while open (Mantine unmounts a closed
          Drawer's children too, but gating here is explicit + keeps a closed
          chrome hook-free). */}
      {opened && <DrawerBody appBlockId={appBlockId} appName={appName} />}
    </Drawer>
  );
}

function DrawerBody({ appBlockId, appName }: { appBlockId: string; appName?: string }) {
  const currentUser = useCurrentUser();
  const isAuthed = currentUser != null;

  const grantsQuery = trpc.blocks.listMyScopeGrants.useQuery(undefined, { enabled: isAuthed });
  const grant = grantsQuery.data?.find((g) => g.appBlockId === appBlockId);

  return (
    <Stack gap="lg">
      {appName && (
        <Text size="sm" c="dimmed">
          The permissions <strong>{appName}</strong> carries through your own installs and consents,
          and what it has done recently. Only you can see this.
        </Text>
      )}

      <Stack gap="xs">
        {/* "…from your installs and consents". #4722 narrowed this to "from your installs"
            because the section's only source WAS install-backed; `listMyScopeGrants` now also
            enumerates live `app_user_scope_grants` rows, so install-only is the narrow
            overstatement in the other direction. Still not the bare "Granted permissions"
            #4722 rejected: the list below is the app's EFFECTIVE set
            (`manifest.scopes ∩ approved_scopes`), not the user's granted set — see the comment
            on `BlockScopeList` below. */}
        <Text fw={600} size="sm">
          Permissions from your installs and consents
        </Text>
        {!isAuthed ? (
          <Text size="xs" c="dimmed" fs="italic">
            Sign in to see the permissions you've granted this app.
          </Text>
        ) : grantsQuery.isLoading ? (
          <Center py="md">
            <Loader size="sm" />
          </Center>
        ) : (
          /* 🔴 THE EMPTY LABEL IS NOT "no permissions granted", AND THE PANEL BELOW IS WHY.
             `grant` is `grants.find(g => g.appBlockId === appBlockId)` over
             `listMyScopeGrants`.
             ⚠️ THE PREVIOUS SENTENCE HERE — "whose only source is the viewer's OWN
             `block_user_subscriptions` rows" — WAS TRUE WHEN #4722 WROTE IT AND IS NOW FALSE.
             That function also enumerates live (non-revoked) `app_user_scope_grants` rows, so
             a full-page app the viewer CONSENTED to now resolves here instead of falling
             through to the empty label. The contradiction #4722 described — this half claiming
             the viewer granted nothing while `AppActivityPanel` below listed that same app's
             scope-gated calls — is fixed at the source rather than described.
             The label still matters for what remains: an app with NEITHER an install NOR a
             consent grant, where absence of a row is still not absence of access.

             🔴 `grant.scopes` IS THE APP'S EFFECTIVE SET — `manifest.scopes ∩
             AppBlock.approved_scopes`, computed by the shared `effectiveBlockScopes` helper
             (`src/shared/constants/block-effective-scopes.ts`) — NOT THE VIEWER'S GRANTED SET.

             ⚠️ TWO EARLIER REVISIONS OF THIS COMMENT WERE WRONG ABOUT WHICH SET THIS IS, and the
             second was wrong about WHY. It first said "MANIFEST-DECLARED SET"; it then said
             "APPROVED SET … the set the MINT honours", citing `block-registry.service.ts`'s "The
             mint sources scopes from `approvedScopes` … NEVER the raw manifest". That sentence was
             MISAPPLIED, not misquoted: it is true of exactly ONE of the THREE scope-sourcing
             sites — the OWNED-NON-APPROVED dev-tunnel mint, resolved by
             `resolveOwnedNonApprovedPageBlock`, in whose docblock it sits — and
             `src/pages/api/v1/block-tokens/index.ts:650` really does
             `clampTunnelDeclaredScopes(app.approvedScopes)` on that path. ⚠️ "The dev-tunnel author
             mint" does NOT identify it: the OTHER dev-tunnel author mint
             (`resolveDevPageBlockForAuthor`, `:469`) sources
             `clampTunnelDeclaredScopes(app.scopes)` — the author's own declared manifest, never
             the column. The PRODUCTION
             run-token mint — the one the apps listed here use — is the THIRD path, and it builds
             the signed set FROM THE MANIFEST (`requestedScopes = knownManifestScopes`) with
             `approved_scopes` as an all-or-nothing 403 veto. Nothing displayed here is "what the
             mint will issue a token for" in any case: that mint refuses unless
             `status === 'approved'`, and `listMyScopeGrants` has NO status filter, so this list
             routinely renders apps no production token can be minted for at all.

             ⚠️ A THIRD CLAIM IS DELETED RATHER THAN REPHRASED: there is NO per-scope
             moderator-narrowing mechanism, so `approvedScopes ⊆ manifest.scopes` is NOT an
             invariant and "a moderator narrowed the approval" was never a reachable reason for a
             divergence. The approve paths write `approvedScopes = manifestScopes` verbatim
             (`publish-request.service.ts`), and that flow is the only writer. The claim that the
             two columns are therefore always replaced together is also false — see
             `src/server/services/blocks/app-listing.service.ts`, which carries the same
             retraction and names the counterexample: `src/pages/api/v1/developer/
             block-manifests.ts` replaces `manifest` + `version` and sets `status: 'pending'`
             WITHOUT touching `approved_scopes`. That publisher-push path is the ONLY source of
             skew, and it skews BOTH ways — v2 adding a scope leaves the approval narrower, v2
             dropping one leaves the approval naming a scope the manifest no longer requests.
             The intersection is the only set that is correct in both rows, which is why it is
             what this list now shows.

             ⚠️ AN EARLIER REVISION ALSO SAID "granted ⊆ manifest BY CONSTRUCTION". THAT IS FALSE;
             the containment holds only AT GRANT TIME. Two writes break it afterwards, and they
             compose: `recordScopeGrant` UNIONS on re-consent (`grantedScopes = existing ∪
             incoming`, `scope-grant.service.ts:232` and `:263`) and nothing ever writes a
             non-null `revoked_at`, so the granted set only GROWS; meanwhile an approved
             subsequent version replaces `manifest` + `approvedScopes` in place on the same
             `AppBlock` row, while the grant is unique on `(userId, appBlockId)` and survives. So
             a publisher who DROPS a scope in v2 leaves the viewer holding a granted scope that
             is in neither the manifest nor `approvedScopes`.

             Consequence for this list, in BOTH directions. It OVERSTATES when the effective set
             is wider than what the viewer granted (the ordinary case). It UNDERSTATES when a
             version removed a scope the viewer still holds — and the intersection does not fix
             that direction, because the dropped scope is absent from the manifest too. The
             understatement is the direction a "permissions you granted" surface most needs to
             show, since nothing else reveals it and a later version re-declaring that scope is
             signed through by `partitionByConsent` with NO fresh prompt.

             Pre-existing, and STILL NOT changed here — the operator decision was taken on a
             different axis (which app-side set to display) and does not settle the
             granted-vs-declared question: `grantedScopes` is not on `ScopeGrantSurface` at all,
             and it is EMPTY for an install-backed row carrying no consent grant, so showing it
             is a new field plus a per-row choice of which set to show — not a swap. Widening the
             population makes it the common case rather than a ~4-row edge, so it remains an open
             decision rather than something silently expanded — see the PR discussion. */
          <BlockScopeList
            scopes={grant?.scopes ?? []}
            emptyLabel="No permissions recorded from an install or consent for this app — which is not the same as no access. Anything it has actually done on your account is listed under Recent activity below."
          />
        )}
      </Stack>

      <Divider />

      <Stack gap="xs">
        <Text fw={600} size="sm">
          Recent activity
        </Text>
        {!isAuthed ? (
          <Text size="xs" c="dimmed" fs="italic">
            Sign in to see this app's recent activity on your account.
          </Text>
        ) : (
          // Only rendered in the authed branch, so enabled defaults to true.
          <AppActivityPanel appBlockId={appBlockId} />
        )}
      </Stack>
    </Stack>
  );
}
