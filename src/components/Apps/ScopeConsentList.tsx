import { Stack } from '@mantine/core';
import { BlockScopeList } from '~/components/Apps/BlockScopeList';
import { buildScopeConsentRows } from '~/components/Apps/scopeConsentRows';
import {
  ScopeConsentAction,
  ScopeRevokeFailureNotice,
  ScopeRevokedAtLine,
  useScopeRevoke,
} from '~/components/Apps/scopeRevoke';

/**
 * PHASE 3 — the ONE permissions block both surfaces render.
 *
 * 🔴 THIS COMPONENT EXISTS SO THE DRAWER AND THE PAGE CANNOT DRIFT, AND THAT IS NOT A
 * HOUSEKEEPING CLAIM — IT IS THE DEFECT CLASS THIS FILE'S NEIGHBOURS HAVE PRODUCED REPEATEDLY.
 * `src/components/AppBlocks/AppPermissionsActivityDrawer.tsx` and `src/pages/apps/activity.tsx`
 * have now had the SAME sentence corrected on one side while the other was missed, in both
 * directions, three separate times: the empty-scope label (fixed by moving it into
 * `scopeGrantEmptyScopeLabel`), the "not the manifest, the intersection" comment on the budget
 * control, and the query-error branch that asserted a denial from a failed read. Each was two
 * copies of one decision. A revoke control is a far worse thing to have two copies of — the
 * failure is not a stale sentence but a permission a viewer withdrew on one surface and is still
 * offered on the other.
 *
 * So both callers pass ONE grant object and this component owns every choice below it: which rows
 * exist, what state each is in, what the control does, where the timestamp goes, and how a
 * failure renders. The only thing a caller still decides is `emptyLabel`, because the honest
 * sentence for "no scopes" genuinely differs by surface — see `scopeGrantEmptyScopeLabel`, whose
 * own docblock owns that difference.
 */

/**
 * The fields of `ScopeGrantSurface` this block reads.
 *
 * Structural rather than a `Pick<ScopeGrantSurface, …>` import: `ScopeGrantSurface` is declared in
 * `src/server/services/blocks/user-app-surface.service.ts`, whose module graph reaches Prisma. A
 * type-only import would be erased at build, but it is also an import every future reader has to
 * re-verify is type-only — and both callers here are handed the row by a tRPC hook, which is
 * structurally typed anyway.
 *
 * ⚠️ `scopesRevokedAt` ACCEPTS A STRING AS WELL AS A `Date`. The client transformer is superjson
 * (`src/utils/trpc.ts`), which does revive a `Date` — but this component is also rendered from
 * component tests whose fixtures are plain objects, and a widened input here costs nothing while
 * a narrow one would push a cast into every fixture.
 */
export type ScopeConsentGrant = {
  appBlockId: string;
  name: string;
  scopes: string[];
  /**
   * ⚠️ OPTIONAL, AND NOT AS A CONVENIENCE — A PRE-PHASE-2 SERVER GENUINELY SENDS A ROW WITHOUT THEM.
   * `listMyScopeGrants` gained these three fields in the same change that added the revoke
   * procedure, and it always emits all three together, so "some present, some absent" is not a state
   * the current server can produce.
   *
   * ⚠️ THE TRIGGER NAMED HERE WAS WRONG AND IS RETRACTED. It read: *"react-query holds this list at
   * `staleTime: Infinity`, so a tab open across the deploy hands this component a row shaped like
   * the OLD surface. `?? []` below is what makes that render a list with no controls instead of
   * throwing."* Both halves are false. An old tab runs the OLD BUNDLE, in which this component does
   * not exist, so a stale cache cannot reach it; the reachable trigger is the MIXED-VERSION WINDOW
   * during a rollout — a new bundle querying a pod still on pre-phase-2 server code. And the `?? []`
   * it describes is GONE for `revokableScopes`: coalescing absent into empty made every row claim it
   * could not be withdrawn, so the absence is now carried through as the `unknown` state. See
   * `buildScopeConsentRows`' parameter docblock.
   */
  revokedScopes?: string[];
  revokableScopes?: string[];
  scopesRevokedAt?: Date | string | null;
};

export function ScopeConsentList({
  grant,
  emptyLabel,
}: {
  grant: ScopeConsentGrant | undefined;
  emptyLabel: string;
}) {
  /**
   * 🔴 THE HOOK IS CALLED UNCONDITIONALLY, WITH PLACEHOLDERS WHEN THERE IS NO GRANT. `grant` is
   * undefined on the drawer whenever `listMyScopeGrants` holds no row for the app being run, and
   * an early `return` above this line would make the hook call conditional — which React forbids
   * and which would crash the drawer on the very next render that DID find a row. There is no
   * reachable control in that state (no rows means no `renderScopeAction` call), so the
   * placeholders are never read.
   */
  const { requestRevoke, pendingScope, failure, justRevoked } = useScopeRevoke({
    appBlockId: grant?.appBlockId ?? '',
    appName: grant?.name ?? 'This app',
  });

  const rows = buildScopeConsentRows({
    scopes: grant?.scopes ?? [],
    /**
     * 🔴 THE SERVER'S LIST UNIONED WITH WHAT THIS SESSION JUST REVOKED — AND THE UNION IS WHAT MAKES
     * THE LOCAL CLAIM SELF-EXPIRING, WITH NO TIMER ANYWHERE. The refetch is deliberately not awaited
     * (see `useScopeRevoke`), so between a successful revoke and the list arriving the server copy
     * still omits the scope; without the union the row went straight back to offering a live "Remove"
     * control for a permission already gone, and a confirm dialog promising to remove it again.
     *
     * Once the server's payload DOES carry the scope, `new Set` makes the local entry contribute
     * nothing — it goes inert on DATA rather than being cleared on a settle. That distinction is the
     * whole round-4 fix: `listMyScopeGrants` reads the REPLICA while the revoke writes the PRIMARY, so
     * "the refetch settled" does NOT imply "the revocation is in the payload", and clearing on the
     * settle flipped the row back to a live control inside replication lag — permanently, because
     * `staleTime: Infinity` means nothing reads again. Full reasoning and the one named residual are
     * on `justRevoked`.
     */
    revokedScopes: [...new Set([...(grant?.revokedScopes ?? []), ...justRevoked])],
    // 🔴 NOT `?? []` — AND THE COALESCE WAS A REAL DEFECT, NOT A TIDINESS NIT. An absent
    // `revokableScopes` made every row `fixed`, so a genuinely withdrawable scope rendered
    // "Can't be withdrawn … granted by platform policy": fail-closed for the action, fail-OPEN
    // for the copy, i.e. a false statement about the viewer's own consent. Passed through as
    // `undefined` so `buildScopeConsentRows` can answer `unknown` and render nothing. See that
    // function's parameter docblock.
    revokableScopes: grant?.revokableScopes,
  });
  const stateByScope = new Map(rows.map((r) => [r.scope, r.state]));

  return (
    <Stack gap="xs" data-testid="scope-consent-list">
      <BlockScopeList
        // The ROW LIST is `buildScopeConsentRows`' output, not `grant.scopes` — a scope the viewer
        // revoked and the publisher later dropped from the manifest is in the second and not the
        // first. See that function's docblock: forgetting a withdrawal is the one thing this
        // surface must never do.
        scopes={rows.map((r) => r.scope)}
        emptyLabel={emptyLabel}
        consent={{
          revokedScopes: rows.filter((r) => r.state === 'revoked').map((r) => r.scope),
          renderScopeAction: (scope) => (
            <ScopeConsentAction
              scope={scope}
              // `?? 'unknown'` can only be reached if `BlockScopeList` were handed a scope this
              // component did not put in `rows`, which is impossible today. `unknown` is the
              // right fallback rather than `fixed`: both withhold the control, but `fixed`
              // ASSERTS the permission is platform-granted and unwithdrawable, and we would have
              // no basis for saying that about a row we cannot account for. Say nothing instead.
              state={stateByScope.get(scope) ?? 'unknown'}
              pendingScope={pendingScope}
              onRevoke={requestRevoke}
            />
          ),
        }}
      />
      {/* App-level, once — NOT per row. `scopesRevokedAt` is one timestamp for the whole (user,
          app) pair, so printing it beside an individual scope would be wrong for every revoke but
          the latest. The rule and its reasoning live on `ScopeRevokedAtLine`. */}
      <ScopeRevokedAtLine scopesRevokedAt={grant?.scopesRevokedAt ?? null} />
      <ScopeRevokeFailureNotice failure={failure} />
    </Stack>
  );
}
