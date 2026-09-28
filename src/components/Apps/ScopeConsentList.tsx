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
   * ⚠️ OPTIONAL, AND NOT AS A CONVENIENCE — A PRE-PHASE-2 CACHE ENTRY GENUINELY LACKS THEM.
   * `listMyScopeGrants` gained these three fields in the same change that added the revoke
   * procedure, and react-query holds this list at `staleTime: Infinity`, so a tab open across the
   * deploy hands this component a row shaped like the OLD surface. `?? []` below is what makes
   * that render a list with no controls instead of throwing on `.includes` of `undefined`.
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
  const { requestRevoke, pendingScope, failure } = useScopeRevoke({
    appBlockId: grant?.appBlockId ?? '',
    appName: grant?.name ?? 'This app',
  });

  const rows = buildScopeConsentRows({
    scopes: grant?.scopes ?? [],
    revokedScopes: grant?.revokedScopes ?? [],
    revokableScopes: grant?.revokableScopes ?? [],
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
              // `?? 'fixed'` can only be reached if `BlockScopeList` were handed a scope this
              // component did not put in `rows`, which is impossible today — and `fixed` is the
              // fail-closed answer if it ever becomes possible: a note, never a control.
              state={stateByScope.get(scope) ?? 'fixed'}
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
