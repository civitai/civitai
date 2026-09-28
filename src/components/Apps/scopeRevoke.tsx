import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { useEffect, useState } from 'react';
import type { ScopeConsentState } from '~/components/Apps/scopeConsentRows';
import { fixedScopeNote } from '~/components/Apps/scopeConsentRows';
import { BLOCK_SPEND_SCOPE } from '~/shared/constants/block-scope.constants';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification, showWarningNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * PHASE 3 — the INTERACTIVE half of the per-scope revoke UI: the confirm step, the mutation,
 * the three per-row renderings, and the two app-level lines.
 *
 * Everything here is shared by BOTH permissions surfaces —
 * `src/components/AppBlocks/AppPermissionsActivityDrawer.tsx` (~408px, mounted over a running
 * app) and `src/pages/apps/activity.tsx` (the full-width "Apps & permissions" tab). The pure
 * row/state half lives in `src/components/Apps/scopeConsentRows.ts`; read that file's docblock
 * first — it owns the rule that the REVOKABILITY DECISION IS THE SERVER'S and is never
 * re-derived on the client.
 *
 * 🔴 `BlockScopeList` STAYS PRESENTATION-ONLY AND KNOWS NONE OF THIS. It has FOUR call sites fed
 * from THREE different scope sets (its own docstring enumerates them), and only two of them are
 * permissions surfaces — `AppSettingsModal` and `AppListingDetailBody` must not grow a revoke
 * control they were never meant to have. So the component takes an OPTIONAL `consent` prop and
 * renders a caller-supplied node; the decision about whether a control exists at all is made
 * here, by the two callers that pass it.
 */

/**
 * ⚠️ NO `SPEND_SCOPE` DECLARATION AND NO RE-EXPORT HERE — read `BLOCK_SPEND_SCOPE` in
 * `~/shared/constants/block-scope.constants` instead, which is what this file now imports.
 *
 * Phase 3 declared the literal here, then round 1 moved it to shared constants and left
 * `export const SPEND_SCOPE = BLOCK_SPEND_SCOPE` behind so `src/pages/apps/activity.tsx` would keep
 * working. Round 2's reuse lane showed that alias defeated the point: the finding was never "the
 * literal is in the wrong file", it was that the BUDGET EDITOR — which predates revoke and is
 * independent of it — took its spend-scope identity from a module that imports `@mantine/core`,
 * `@mantine/modals`, `trpc` and `formatDate` to render a revoke dialog. Re-exporting preserved that
 * dependency edge verbatim while the docblock above it claimed the edge was the reason for moving.
 * A rename is not a consolidation.
 */

/**
 * What a revoke actually does, in the viewer's terms — the confirm step's body.
 *
 * 🔴 EVERY CLAIM BELOW IS SOURCED, AND THE TWO EASY OVERSTATEMENTS ARE DELIBERATELY ABSENT.
 *
 *   - "stops working straight away" — phase 2's revoke publishes a FAIL-CLOSED suppression
 *     marker to Redis (`ConsentRevocation.publish`) before returning, and
 *     `block-scope.middleware` refuses a revoked scope on an ALREADY-MINTED token from that
 *     marker. So this is NOT the weaker "at the next token refresh" that a durable-row-only
 *     revoke would justify. ⚠️ The one state where it IS weaker is a Redis publish failure, and
 *     that state does not go unreported: the server answers 503 with
 *     `CONSENT_REVOKE_MARKER_DEGRADED_MESSAGE`, which says so in those words, and
 *     `useScopeRevoke` below surfaces it instead of a success.
 *   - "may ask you for it again" — a revoked scope lands in `partitionByConsent`'s `missing`,
 *     which is an explicit consent PROMPT, not a silent re-grant.
 *   - "saying yes to that prompt gives it back" — true, by design, and stated rather than
 *     hidden. A re-consent runs `clearRevocations`, so it lifts the suppression. Leaving this
 *     out would let a viewer read the revoke as permanent and be surprised by their own next
 *     click; it is not a leak, and describing it as one would be the overstatement in the other
 *     direction.
 *
 * ⚠️ IT DOES NOT SAY "THIS UNINSTALLS THE APP" OR "THIS DELETES ITS DATA", because neither is
 * true — revoke and uninstall are different operations on different rows, which is the same
 * distinction the /apps/activity tab copy is careful about at the other end.
 */
export function ScopeRevokeConfirmBody({ appName, scope }: { appName: string; scope: string }) {
  return (
    <Stack gap="xs" data-testid="scope-revoke-confirm-body">
      <Text size="sm">
        <strong>{appName}</strong> will stop being able to use <code>{scope}</code> straight away —
        including in a session you already have open.
      </Text>
      <Text size="sm">
        The app may ask you for this permission again the next time you open it. That ask is a
        prompt you have to accept, and accepting it does give the permission back.
      </Text>
      {scope === BLOCK_SPEND_SCOPE ? (
        <Text size="sm" data-testid="scope-revoke-confirm-budget-note">
          This also clears the daily Buzz limit you set for this app. A limit on a spend the app can
          no longer make bounds nothing, and leaving it stored would bring it back as a live limit
          if you ever re-granted the permission.
        </Text>
      ) : null}
      {/* 🔴 MORE HAPPENS THAN THE SENTENCES ABOVE PROMISE, AND IT HAS TO BE SAID. For an app whose
          auth is mirrored into an `OauthConsent` row, `blocks.revokeScopes` runs
          `revokeOauthConsentForBlock`, which `deleteMany`s EVERY `Access`/`Refresh` key for that
          client and the whole consent row — not just the scope being withdrawn. So a viewer who
          removes one permission can find the app fully signed out. Removing more than promised is
          the safe direction, but being surprised by it is not, and the correctness-review lane was
          right that the dialog said nothing about it.
          ⚠️ HEDGED ON PURPOSE. The client is not told whether this app has an OAuth mirror —
          `ScopeGrantSurface` carries no such field, and the server gates the teardown on a live
          row it reads at mutation time. So the sentence is conditional rather than asserted; an
          unconditional "this signs the app out" would be false for the majority of apps, which
          have no mirror at all. */}
      <Text size="sm" data-testid="scope-revoke-confirm-signout-note">
        If this app signs you in with Civitai, removing a permission also signs it out — you may
        need to sign in to it again.
      </Text>
      <Text size="sm" c="dimmed">
        This does not uninstall the app or remove anything it has already saved — those are separate
        from the permission.
      </Text>
    </Stack>
  );
}

/**
 * The failure a revoke can leave on screen, as distinct from a notification that has faded.
 *
 * `degraded` is the 503 half and it is NOT an error in the sense the viewer cares about: the
 * permission WAS removed durably and only the in-flight-token half is lagging. Collapsing the
 * two into one "could not remove" message would tell a viewer nothing was recorded when the
 * half that governs every future mint was.
 */
export type ScopeRevokeFailure = {
  message: string;
  degraded: boolean;
};
/**
 * ⚠️ A `scope: string` FIELD WAS DROPPED FROM THIS TYPE — it was dead data. Nothing read it:
 * `ScopeRevokeFailureNotice` renders app-level, not per-row, so the field was set on every failure
 * and consumed by nothing, which also made `scope: variables.scopes[0] ?? ''` a mutation no test
 * could ever kill. Carrying a value the UI does not branch on is the shape that later reads as a
 * per-scope guarantee this surface does not make. Found by the test-review lane.
 */

/**
 * The revoke mutation plus its confirm gate, for ONE app.
 *
 * 🔴 THE MUTATION IS ONLY EVER REACHED FROM `onConfirm`. There is no direct-fire path: the
 * button opens the dialog and nothing else calls `mutate`, which is what makes the confirm step
 * a gate rather than a decoration. Pinned by the cancel arm of
 * `src/components/Apps/ScopeRevoke.browser.test.tsx`, which asserts ZERO mutation calls.
 *
 * 🔴 THE THREE OUTCOMES ARE HANDLED SEPARATELY BECAUSE THEY MEAN DIFFERENT THINGS, and the
 * middle one is the trap. `blocks.revokeScopes` can answer:
 *   - 2xx              → removed, and enforced immediately. Invalidate; say so.
 *   - 503              → removed DURABLY, but the in-flight-token marker did not go out. The
 *                        row must be re-read (it changed!) and the viewer told the honest
 *                        partial truth. Treating this as a plain failure would leave the list
 *                        showing a permission that is actually gone.
 *   - 412 PRECONDITION → the hand-applied `revoked_scopes` migration has not run on this
 *                        environment. The server's own message ends "Nothing was changed", so
 *                        this is the ONE error where a re-read buys nothing, and it is the one
 *                        error that is a real, expected runtime state rather than a fault.
 * Anything else is ambiguous about whether the row moved, so it re-reads too — an extra query
 * is cheaper than a permissions list that disagrees with the database.
 *
 * ⚠️ THE MESSAGE IS THE SERVER'S, NOT A CLIENT COPY OF IT. `CONSENT_REVOKE_UNAVAILABLE_MESSAGE`
 * and `CONSENT_REVOKE_MARKER_DEGRADED_MESSAGE` are exported from
 * `src/server/services/blocks/scope-grant.service.ts` and
 * `src/server/services/blocks/consent-revocation.service.ts`, and both of those modules pull in
 * the Prisma client — importing either to render a string would drag the server graph into the
 * browser bundle. Both are carried on 4xx/503 codes specifically so
 * `src/server/trpc/client-safe-error.ts` does not replace them (it rewrites every
 * `status >= 500 && status !== 503`), so `error.message` IS the sentence the constant declares.
 * A client-side second copy would be the drift this arc keeps paying for.
 */
export function useScopeRevoke({
  appBlockId,
  appName,
  serverRevokedScopes,
}: {
  appBlockId: string;
  appName: string;
  /**
   * The server's own `revokedScopes` for this app. Read ONLY to latch pending entries off — this
   * hook never renders it, and the row list still comes from `buildScopeConsentRows`.
   */
  serverRevokedScopes: string[];
}) {
  const utils = trpc.useUtils();
  const [pendingScope, setPendingScope] = useState<string | null>(null);
  const [failure, setFailure] = useState<ScopeRevokeFailure | null>(null);
  /**
   * 🔴 SCOPES THIS SESSION HAS SUCCESSFULLY REVOKED, HELD LOCALLY UNTIL THE SERVER LIST CATCHES UP.
   * Without it the round-1 fix introduced a new defect: clearing `pendingScope` in `.finally` no
   * longer waits for the refetch (which is the point — see the ordering block below), so for the
   * duration of those four DB round trips the row still listed the scope as revokable WITH AN
   * ENABLED "Remove" button. A viewer could press it again and get a confirm dialog saying the app
   * "will stop being able to use" a permission that was already gone, then a second mutation and a
   * second success toast. Server-side that is a harmless union write, but a consent surface
   * asserting an action it is not performing is exactly what this phase exists to stop. Found by the
   * round-2 correctness lane, which also noted the new PENDING test arm *pinned* the bad behaviour.
   *
   * 🔴 CLEARED AS SOON AS THE REFETCH SETTLES — IT IS A WINDOW, NOT AN OVERRIDE. An earlier version
   * held it for the component's lifetime and argued that was "the safe direction for a consent
   * surface (over-reporting a withdrawal, never under-reporting one)". THAT IS RETRACTED, AND IT WAS
   * BACKWARDS. `src/pages/apps/activity.tsx` already states the rule for this exact surface:
   * *"Telling that viewer the app has no access is the one direction a permissions page must never
   * be wrong in."* Over-reporting a withdrawal IS telling them the app has no access. Two comments
   * in one component asserting opposite principles, and the sticky one was the wrong half.
   *
   * 🔴 IT WAS ALSO PRODUCTION-WRONG, NOT MERELY MIS-ARGUED. `buildScopeConsentRows` tests `revoked`
   * FIRST, and the `revoked` row renders "Removed", the sentence "You withdrew this", and NO control
   * — so a permanent entry here overrode fresh server data and left a dead end. A re-grant is a real
   * path: `blocks.grantScopes` passes `clearRevocations: true`, so after one the server correctly
   * reports the scope as not-revoked AND revokable. The race-free sequence found by the round-3
   * correctness lane: revoke in the run-frame drawer (which stays mounted), the block behind it fires
   * `REQUEST_CONSENT`, the viewer re-grants with a budget, then revokes anything else in the same
   * drawer — that second revoke's refetch brings back authoritative data saying spend is LIVE, and the
   * sticky entry painted "Removed" over it. A surface claiming an app can no longer spend the
   * viewer's Buzz while it can, with a stored daily limit, and no way to withdraw it.
   *
   * 🔴 THE ENTRY GOES INERT ON **DATA**, NOT ON A TIMER, A CLOCK, OR THE REFETCH SETTLING — and the
   * settle-based version was wrong for a reason no amount of promise-ordering care could fix.
   *
   * ⚠️ RETRACTED: round 3 cleared the entry in the invalidate's `.finally`, on the stated guarantee
   * that *"a refetch that SUCCEEDS carries the revocation, so the row stays 'Removed' on the server's
   * authority."* THE REFETCH DOES NOT READ THE DATABASE THE REVOKE WROTE TO. `revokeScopes` reads and
   * writes the grant row on the PRIMARY (`dbWrite` — deliberately, it is a read-modify-write of a
   * consent ledger); `listMyScopeGrants` reads that same row off the REPLICA (`dbRead`), which
   * `packages/civitai-db` constructs as a SEPARATE client whenever a replica URL is configured
   * (`dbRead = singleClient ? dbWrite : createPrismaClient({ readonly: true })`). So a refetch can
   * SUCCEED carrying the PRE-REVOKE row, and clearing on the settle then flipped the row back to a
   * live "Remove" button with a stale timestamp — reinstating, for the same viewer and the same
   * click, exactly the confirm-dialog-for-an-already-gone-permission this set exists to prevent.
   *
   * 🔴 AND IT DID NOT SELF-HEAL. `src/utils/trpc.ts` sets `staleTime: Infinity` and
   * `refetchOnWindowFocus: false`, so nothing schedules another read: round 2's bad window was
   * bounded by the refetch, round 3's by NAVIGATION — on a drawer whose whole point is staying
   * mounted. This repo argues the same lag twice INSIDE the revoke procedure: `blocks.router.ts`
   * takes its OAuth teardown gate reads off `dbWrite` because *"the replica version reintroduced the
   * hole this gate exists to close … a viewer who … withdraws a permission moments later lands
   * inside replication lag"*. Same row, same actor, same timing. Found by the round-4 lane.
   *
   * 🔴 SO THE ENTRY IS **LATCHED OFF** THE FIRST TIME A PAYLOAD CONFIRMS IT — a terminal state, not a
   * mask recomputed each render. `confirmRevokedByServer` below drops the scope permanently the
   * moment any `listMyScopeGrants` payload carries it, and nothing can put it back.
   *
   * ⚠️ RETRACTED AGAIN, AND THIS IS THE DISTINCTION THAT COST TWO ROUNDS. Round 4 removed the
   * clearing step and claimed the union alone made the entry "self-expiring" — *"the moment the
   * server's payload carries the revocation the entry is redundant and contributes nothing"*. It is
   * redundant IN THAT PAYLOAD ONLY. The union is recomputed on every render, so the entry was merely
   * SHADOWED, and `revokedScopes` is not monotonic — a re-grant is precisely the write that removes a
   * scope from it (`grantScopes` → `clearRevocations: true`). So the entry went live again on the next
   * payload that dropped the scope, which re-shipped round 3's defect at FULL WIDTH rather than
   * narrowing it to replication lag: revoke in the drawer, the block fires `REQUEST_CONSENT`, the
   * viewer re-grants with a budget, then revokes anything else in the same drawer — and the spend row
   * reads "Removed / You withdrew this" with no control while the budget editor renders live beside
   * it. No replication lag anywhere in that sequence. Found by the round-5 lane.
   *
   * The correct reading of "expire on data" is to LATCH the observation, not to re-derive a mask: the
   * client has already SEEN a payload carrying the revocation, and that observation is the
   * confirmation. Once latched there is nothing left for a later payload to resurrect.
   *
   * ⚠️ ONE RESIDUAL, AND NOW GENUINELY BOUNDED: an entry never latches when NO CONFIRMING PAYLOAD
   * ARRIVES AFTER IT IS ADDED, and a later re-grant then leaves that row reading "Removed" until
   * unmount. ⚠️ The precondition is that, not the narrower "re-grants before any payload ever
   * confirms" an earlier wording used: a payload that carries the scope BEFORE the `.then` adds it
   * leaves `confirmedKey` unchanged, so the effect never re-fires. Reaching that needs a competing
   * `listMyScopeGrants` refetch to complete inside the post-write tail of this mutation — the inverse
   * of the replication-lag ordering rounds 3-5 were about. Same class, same trigger, wider
   * precondition. Round-6 lane, so that row reads "Removed"
   * until this component unmounts. That case needs a signal separating "no payload has confirmed yet"
   * from "the row was re-granted", and none exists — `scopesRevokedAt` is explicitly NON-monotonic (a
   * clearing re-grant nulls it, and the whole-grant path writes `null` when the list empties), while
   * `grantedScopes`, `spendScopeGranted`, `buzzBudgetPerDay`, `surfaces` and `origin` carry nothing
   * version-like. A monotonic row version, or a primary-read variant of `listMyScopeGrants`, would
   * settle it; both are server changes this phase is scoped out of.
   */
  const [justRevoked, setJustRevoked] = useState<string[]>([]);

  /**
   * THE LATCH. Drops any pending entry the server has now confirmed, permanently.
   *
   * 🔴 KEYED ON A JOINED STRING — A CONTENT KEY, NOT AN IDENTITY ONE. The updater also returns the
   * PREVIOUS array unchanged when nothing was dropped, so React bails out by `Object.is` and a no-op
   * cannot start a render loop. `\u0000` is the separator because it cannot occur in a scope id
   * (every key of `BLOCK_SCOPE_TO_OAUTH_BIT` is `[a-z:]+`, and Postgres `text[]` cannot hold a NUL
   * at all), so two different lists cannot join to one key.
   *
   * ⚠️ THE REASON GIVEN HERE FOR THE STRING DEP WAS FALSE AND IS RETRACTED. It read: *"`serverRevokedScopes`
   * comes off react-query and is a fresh array identity on every render, so using it directly as a
   * dependency would re-run this on every render."* react-query's `data` — and the nested array inside
   * it — is identity-STABLE across renders; with `staleTime: Infinity` and default structural sharing
   * it changes only when the CONTENT changes. The only per-render fresh array is the `?? []` coalesce
   * at the call site in `ScopeConsentList`, reachable when the drawer holds no grant row or a
   * pre-phase-2 payload omits the field — and in exactly that state the array is always EMPTY, so a
   * raw-array dep would have cost one extra no-op effect per render, never a loop.
   *
   * The string dep is still the right choice, for a different reason: a content key is correct under
   * BOTH identity behaviours, so it does not depend on a library detail at all. But this file already
   * carries a retraction saying a comment asserting a library behaviour that does not exist is worse
   * than no comment, and this was another one. Found by the round-6 lane.
   */
  const confirmedKey = serverRevokedScopes.join('\u0000');
  useEffect(() => {
    const confirmed = new Set(confirmedKey.length > 0 ? confirmedKey.split('\u0000') : []);
    setJustRevoked((prev) => {
      const next = prev.filter((s) => !confirmed.has(s));
      return next.length === prev.length ? prev : next;
    });
  }, [confirmedKey]);

  /**
   * 🔴 NO `onSuccess`/`onError`/`onSettled` OPTIONS — THE OUTCOME IS HANDLED IN THE `onConfirm`
   * CLOSURE. THE REASON IS ORDERING (see the block on the chain below), NOT LIFECYCLE.
   *
   * ⚠️ A PREVIOUS VERSION OF THIS DOCBLOCK GAVE A DIFFERENT AND FALSE REASON, AND IT IS RETRACTED
   * RATHER THAN REWORDED. It said: *"the dialog outlives this component … react-query unsubscribes
   * this `useMutation` observer, so confirming still fired the mutation SERVER-SIDE while none of
   * the option callbacks ran … The permission changed and the viewer was told nothing."* Two lanes
   * independently reported that hazard in round 1 and the round-2 correctness lane RETRACTED it
   * after reading the installed source: in `@tanstack/query-core@5.101.0`, `Mutation.execute`
   * awaits `this.options.onSuccess/onError/onSettled` **unconditionally**, with no reference to
   * `#observers`. The only listener-gated path is `MutationObserver.#notify`, which fires
   * `#mutateOptions` — the PER-CALL options passed as `mutate(vars, options)`, which this code
   * never used. Hook options become the MUTATION's options (`useMutation` →
   * `observer.setOptions` → `mutationCache.build(client, this.options)`), so they would have fired
   * after unmount. There was nothing to fix.
   *
   * The premise about the dialog is still true — `openConfirmModal` renders into the global
   * `CustomModalsProvider` in `src/pages/_app.tsx`, so it does outlive this component — but the
   * conclusion drawn from it was wrong, and a comment asserting a library behaviour that does not
   * exist is worse than no comment: the next reader trusts it, and the test fixture below was
   * written to ENFORCE this shape on that false rationale.
   *
   * WHAT IS STILL TRUE AND IS THE REAL REASON TO KEEP THIS SHAPE: handling the outcome here is what
   * lets the viewer be told BEFORE the cache is reconciled, which the option-callback form could not
   * express (`execute` awaits `onSuccess` before `onSettled`, so an `await invalidate()` inside
   * `onSuccess` necessarily delayed the spinner). React is 18.3.1, so the two `setState` calls are
   * no-ops rather than warnings if this does unmount mid-flight — a property worth having, just not
   * the reason for the design.
   */
  const mutation = trpc.blocks.revokeScopes.useMutation();

  const requestRevoke = (scope: string) => {
    openConfirmModal({
      title: `Remove ${scope}?`,
      children: <ScopeRevokeConfirmBody appName={appName} scope={scope} />,
      labels: { confirm: 'Remove permission', cancel: 'Keep it' },
      confirmProps: { color: 'red', 'data-testid': 'scope-revoke-confirm' },
      cancelProps: { 'data-testid': 'scope-revoke-cancel' },
      onConfirm: () => {
        // Clear any previous failure so a retry does not render last attempt's message beside a
        // fresh spinner.
        setFailure(null);
        setPendingScope(scope);
        mutation
          .mutateAsync({ appBlockId, scopes: [scope] })
          /**
           * 🔴 TELL THE VIEWER FIRST, RECONCILE THE CACHE AFTER — AND THE `invalidate()` IS
           * DELIBERATELY NOT AWAITED. `queryClient.invalidateQueries` returns
           * `refetchQueries(...)`, so awaiting it waits for the whole `listMyScopeGrants` refetch,
           * which is FOUR sequential DB round trips — and one of them,
           * `blockScopeInvocation.groupBy`, has no time predicate and no LIMIT, so it scales with
           * the viewer's lifetime App Block audit-row count (there is no pruning job for that
           * table). Awaiting it put the spinner, the success toast, the 503 warning AND the inline
           * failure notice behind that refetch.
           *
           * 🔴 THE 503 ARM IS WHY THIS IS A DEFECT AND NOT A PREFERENCE. That arm exists to say
           * "the permission is gone but enforcement is lagging" — and Redis being unhealthy is
           * exactly when the extra round trips are least likely to be quick. Awaiting delayed the
           * one message whose whole value is arriving promptly, at the one moment it mattered.
           * Measured by the perf-review lane against `@tanstack/query-core@5.101.0`.
           *
           * ⚠️ DECLINED, WITH REASONING: also patching the row via
           * `utils.blocks.listMyScopeGrants.setData(...)` from the mutation's return payload. The
           * server does return `revokedScopes`/`grantedScopes` for exactly that purpose, and 246
           * call sites in this repo use `setData`. But the return does NOT carry
           * `scopesRevokedAt`, which `ScopeConsentList` renders, so `setData` cannot replace the
           * invalidate — it would only make the row correct a few hundred ms sooner while the same
           * refetch still ran. Once the refetch is off the interactive path, that is polish rather
           * than a fix, and it adds a second writer of this cache entry.
           */
          /**
           * 🔴 TWO ARGUMENTS TO `.then`, NOT `.then(...).catch(...)` — AND THE DIFFERENCE IS A REAL
           * MISREPORT. With a chained `.catch`, anything the SUCCESS arm throws lands in the failure
           * handler: a throw from `showSuccessNotification`, or a synchronous throw out of
           * `invalidate()`, would paint the red inline "could not remove" notice over a revoke that
           * SUCCEEDED. `.then(onFulfilled, onRejected)` scopes the rejection handler to the mutation
           * itself, which is the only thing it is allowed to be about. Found by the round-2
           * correctness lane; the option-callback form had the same hazard by a different route
           * (`execute` awaits `onSuccess` inside its own `try`).
           */
          .then(
            () => {
              // The local sticky set FIRST, so the row stops offering a control in the same commit as
              // the toast — see `justRevoked`.
              setJustRevoked((prev) => (prev.includes(scope) ? prev : [...prev, scope]));
              showSuccessNotification({
                title: 'Permission removed',
                message: `${appName} can no longer use ${scope}.`,
              });
              // Un-awaited — the viewer has already been told and the spinner must not wait on it.
              // The local claim is NOT cleared here; it goes inert on its own once the server's
              // payload carries the revocation. See `justRevoked`.
              void utils.blocks.listMyScopeGrants.invalidate();
            },
            (error: { data?: { code?: string }; message?: string }) => {
              const code = error?.data?.code;
              const degraded = code === 'SERVICE_UNAVAILABLE';
              const message = error?.message ?? 'The permission could not be removed just now.';
              setFailure({ message, degraded });
              if (degraded) {
                // A WARNING, not an error: the permission IS gone. The notification and the inline
                // notice carry the same server sentence rather than two paraphrases of it.
                showWarningNotification({ title: 'Permission removed', message });
                // 🔴 AND IT COUNTS AS REVOKED FOR THE ROW, exactly as a 2xx does. On a 503 Postgres
                // was written and only the in-flight-token marker failed, so the permission really is
                // withdrawn — leaving a live "Remove" control on it would be the same misreport as
                // the success path's, in the arm that is already telling the viewer it is gone.
                setJustRevoked((prev) => (prev.includes(scope) ? prev : [...prev, scope]));
              }
              // See the hook docblock: 412 is the only outcome the server states left the row
              // untouched, so it is the only one that buys nothing by re-reading. Un-awaited, and
              // AFTER the viewer has been told — see the block above.
              if (code !== 'PRECONDITION_FAILED') void utils.blocks.listMyScopeGrants.invalidate();
            }
          )
          // `finally` rather than clearing in each arm — a spinner that outlives its mutation is
          // the failure mode a per-arm reset produces the first time a third arm is added.
          .finally(() => setPendingScope(null))
          /**
           * 🔴 A TERMINAL NO-OP CATCH, AND IT CLOSES A HOLE THE `.then(f, r)` CHANGE OPENED. With the
           * previous `.then(f).catch(r)`, a throw from the SUCCESS arm fell into `r` — wrong (it
           * painted "could not remove" over a success), which is why the arms were split. But once
           * split, a throw from `f`, from `r`, or from the `finally` has NO handler at all: the chain
           * rejects and the browser reports an unhandled rejection. Not a user-visible lie, so a
           * strictly better failure than the one it replaced — but still a silent console error on a
           * consent surface, and it was created by the fix rather than found in the original.
           *
           * Swallowing is the right action here rather than reporting: every path into this catch has
           * ALREADY told the viewer its outcome (a toast, or the inline notice, or both). A second
           * message derived from a notification helper having thrown would describe the messenger, not
           * the revoke.
           */
          .catch(() => {
            /* the outcome was already reported by the arm that threw — see above */
          });
      },
    });
  };

  return { requestRevoke, pendingScope, failure, justRevoked };
}

/**
 * The per-row consent control: a real button, an honest note, or a removed marker.
 *
 * 🔴 NO DISABLED BUTTON FOR A `fixed` SCOPE, EVER. A greyed-out "Remove" says "you could do
 * this if something changed", and nothing the viewer can do will ever make a consent-exempt
 * scope withdrawable — `partitionByConsent` signs it on the exempt test ALONE, before it looks
 * at the grant. The note says what governs it instead, which is the only true thing available.
 * Silence is the other rejected option: a row with no affordance and no explanation reads as an
 * oversight next to rows that have one.
 */
export function ScopeConsentAction({
  scope,
  state,
  pendingScope,
  onRevoke,
}: {
  scope: string;
  state: ScopeConsentState;
  pendingScope: string | null;
  onRevoke: (scope: string) => void;
}) {
  if (state === 'revoked') {
    return (
      <Group gap={6} wrap="nowrap" data-testid="scope-revoked-row">
        <Badge size="xs" variant="light" color="gray" data-testid="scope-revoked-mark">
          Removed
        </Badge>
        <Text size="xs" c="dimmed">
          You withdrew this. The app may ask for it again next time you open it.
        </Text>
      </Group>
    );
  }
  if (state === 'fixed') {
    return (
      <Text size="xs" c="dimmed" fs="italic" data-testid="scope-fixed-note">
        {fixedScopeNote(scope)}
      </Text>
    );
  }
  /**
   * 🔴 `unknown` RENDERS NOTHING — NOT A NOTE, AND NOT A DISABLED CONTROL. The server did not tell
   * us whether this scope is withdrawable (a pre-phase-2 payload during a rollout's mixed-version
   * window), and every sentence available here would be a claim we cannot support. `fixed`'s note
   * would assert the permission is platform-granted and permanent; a control would offer an action
   * the server may refuse. Silence is the only honest option for this state specifically — which
   * is the opposite of the `fixed` case, where silence would read as an oversight next to rows
   * that have an affordance. See `ScopeConsentState` in `scopeConsentRows.ts`.
   */
  if (state === 'unknown') return null;
  return (
    <Group gap="xs" justify="flex-start">
      <Button
        size="compact-xs"
        variant="subtle"
        color="red"
        // `pendingScope === scope`, not a bare `isPending`: one hook serves every row of one
        // app, so a shared boolean would spin every button on the card at once.
        loading={pendingScope === scope}
        disabled={pendingScope !== null && pendingScope !== scope}
        data-testid="scope-revoke-button"
        data-scope={scope}
        onClick={() => onRevoke(scope)}
      >
        Remove
      </Button>
    </Group>
  );
}

/**
 * The app-level "you last withdrew something on <date>" line.
 *
 * 🔴 APP-LEVEL, AND THAT IS NOT A STYLING CHOICE — IT IS THE ONLY HONEST PLACE FOR THIS VALUE.
 * `ScopeGrantSurface.scopesRevokedAt` is ONE timestamp per (user, app): `revoked_scopes` is a
 * `TEXT[]` with nowhere to hold per-entry times, so two revokes a week apart leave only the
 * later one. Its own docblock states the consequence in terms — *"it is honest as an app-level
 * 'permissions last changed <when>' and it is a LIE printed next to an individual scope row"* —
 * so a per-row "revoked <when>" label would be wrong for every revoke but the most recent.
 * ⚠️ True per-scope times are a CHILD TABLE, i.e. a schema change, deliberately not built. Do
 * not "improve" this by moving the date onto the row.
 */
export function ScopeRevokedAtLine({ scopesRevokedAt }: { scopesRevokedAt: Date | string | null }) {
  if (!scopesRevokedAt) return null;
  const when = new Date(scopesRevokedAt);
  // A malformed value from the wire renders nothing rather than "Invalid Date".
  if (Number.isNaN(when.getTime())) return null;
  return (
    <Text size="xs" c="dimmed" data-testid="scope-revoked-at">
      You last removed a permission from this app on {formatDate(when, 'YYYY-MM-DD')}.
    </Text>
  );
}

/**
 * The inline result of a failed (or partially-failed) revoke.
 *
 * 🔴 INLINE AND PERSISTENT, NOT ONLY A NOTIFICATION. A Mantine notification auto-closes in 3
 * seconds; the pre-migration `PRECONDITION_FAILED` state is not a transient blip but a property
 * of the environment the viewer is on, and it will recur on every press. A viewer who clicked
 * "Remove permission" and looked away needs to be able to see, on the surface itself, that
 * nothing happened — otherwise the outcome is indistinguishable from a silent no-op, which is
 * the single worst result available on a consent surface.
 *
 * ⚠️ THE PRECEDENT FOR THAT DECISION IS THE `AppCollaboratorsPanel` PAIR — read it before "fixing"
 * this to match it. Same folder, same job (an inline, persistent, app-level refusal rather than a
 * toast) and the same argument, written independently. The argument is in
 * `src/components/Apps/AppCollaboratorsPanel.tsx`: *"a transient toast is exactly where a reason goes
 * to die."* The `Alert` that implements it is in the sibling
 * `src/components/Apps/AppCollaboratorsPanelView.tsx`. ⚠️ An earlier revision credited BOTH to the
 * View file, so a reader following the pointer for the quote would not have found it — the
 * round-3 correctness lane caught the misattribution. `AlertWithIcon` is a third spelling of the same
 * thing, with ~47 consumers elsewhere in the repo.
 *
 * A plain `Text` is used here INSTEAD, for one measured reason: this component renders inside the
 * ~408px run-frame drawer as well as the wide page, and an `Alert`'s icon, border and padding cost
 * roughly 64px of that 408 before any of the message is drawn. The drawer is the width the phase-1
 * truncation fix was bought back at, so spending it on chrome around a sentence is the wrong trade
 * there. On the wide page an `Alert` would be the better spelling, and taking one component to two
 * renderings by container width is a worse trade than one quieter spelling in both.
 *
 * 🔴 RECORDED HERE RATHER THAN LEFT AS TASTE, because the divergence is what it is: two spellings
 * of one decision, 40 lines apart in one folder. Without the cross-reference the next author finds
 * `AppCollaboratorsPanelView` first, "aligns" this one, and silently narrows the drawer — or adds a
 * third spelling. Reported by the reuse-review lane, twice.
 */
export function ScopeRevokeFailureNotice({ failure }: { failure: ScopeRevokeFailure | null }) {
  if (!failure) return null;
  return (
    <Text
      size="xs"
      // Orange for the degraded case (it WORKED; enforcement lags) and red for a real refusal.
      // The colour is the only thing that differs — the sentence is the server's either way.
      c={failure.degraded ? 'orange' : 'red'}
      data-testid="scope-revoke-failure"
      data-degraded={failure.degraded ? 'true' : 'false'}
    >
      {failure.message}
    </Text>
  );
}
