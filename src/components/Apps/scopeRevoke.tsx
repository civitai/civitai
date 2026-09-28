import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { useState } from 'react';
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
 * ⚠️ `SPEND_SCOPE` WAS DECLARED HERE AND HAS MOVED TO `~/shared/constants/block-scope.constants`
 * AS `BLOCK_SPEND_SCOPE` — re-exported under the old name only for the two `Apps/` call sites.
 *
 * Phase 3 first moved the literal out of `src/pages/apps/activity.tsx` into this file, on the
 * correct argument that the budget editor and the revoke dialog must agree about which scope they
 * mean. The reuse-review lane pointed out two things that made this the wrong home: a THIRD copy
 * already existed in `src/components/AppBlocks/BlockConsentModal.tsx` with a byte-identical name and
 * doc sentence, so the move consolidated 2→1 while leaving 3 in the tree; and putting a scope id in
 * a module that imports Mantine, `@mantine/modals`, `trpc` and `formatDate` inverts the dependency —
 * the budget editor, which predates revoke, would import its spend-scope identity from the revoke
 * feature. The shared constants module is client-safe, owns the scope vocabulary, and is already
 * imported by all three surfaces. Full reasoning lives on `BLOCK_SPEND_SCOPE`.
 */
export const SPEND_SCOPE = BLOCK_SPEND_SCOPE;

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
        <strong>{appName}</strong> will stop being able to use <code>{scope}</code> straight away
        — including in a session you already have open.
      </Text>
      <Text size="sm">
        The app may ask you for this permission again the next time you open it. That ask is a
        prompt you have to accept, and accepting it does give the permission back.
      </Text>
      {scope === SPEND_SCOPE ? (
        <Text size="sm" data-testid="scope-revoke-confirm-budget-note">
          This also clears the daily Buzz limit you set for this app. A limit on a spend the app
          can no longer make bounds nothing, and leaving it stored would bring it back as a live
          limit if you ever re-granted the permission.
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
        This does not uninstall the app or remove anything it has already saved — those are
        separate from the permission.
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
export function useScopeRevoke({ appBlockId, appName }: { appBlockId: string; appName: string }) {
  const utils = trpc.useUtils();
  const [pendingScope, setPendingScope] = useState<string | null>(null);
  const [failure, setFailure] = useState<ScopeRevokeFailure | null>(null);

  /**
   * 🔴 NO `onSuccess`/`onError`/`onSettled` OPTIONS — THE OUTCOME IS HANDLED IN THE `onConfirm`
   * CLOSURE, AND THAT IS A CORRECTNESS FIX RATHER THAN A STYLE CHOICE.
   *
   * `openConfirmModal` renders into the GLOBAL `CustomModalsProvider` (`src/pages/_app.tsx`), so
   * the dialog outlives this component. If the tree holding the hook unmounts while the dialog is
   * open — the run-frame drawer closing is the reachable shape — react-query unsubscribes this
   * `useMutation` observer, so confirming still fired the mutation SERVER-SIDE while none of the
   * option callbacks ran: no cache invalidation, no success notification, and critically no 503
   * warning and no inline failure notice. The permission changed and the viewer was told nothing,
   * which is the exact outcome `ScopeRevokeFailureNotice`'s docblock calls the worst available on
   * a consent surface. Found by the correctness-review lane.
   *
   * `mutateAsync` returns a promise from the Mutation itself, not from the observer, so the chain
   * below runs whether or not this component is still mounted. `utils.*.invalidate` and the
   * notification helpers are both global singletons, so the two things the viewer actually needs
   * happen regardless; only the two `setState` calls are lifecycle-bound, and a `setState` on an
   * unmounted component is a no-op in React 18 rather than a warning.
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
          .then(() => {
            showSuccessNotification({
              title: 'Permission removed',
              message: `${appName} can no longer use ${scope}.`,
            });
            void utils.blocks.listMyScopeGrants.invalidate();
          })
          .catch((error: { data?: { code?: string }; message?: string }) => {
            const code = error?.data?.code;
            const degraded = code === 'SERVICE_UNAVAILABLE';
            const message = error?.message ?? 'The permission could not be removed just now.';
            setFailure({ message, degraded });
            if (degraded) {
              // A WARNING, not an error: the permission IS gone. The notification and the inline
              // notice carry the same server sentence rather than two paraphrases of it.
              showWarningNotification({ title: 'Permission removed', message });
            }
            // See the hook docblock: 412 is the only outcome the server states left the row
            // untouched, so it is the only one that buys nothing by re-reading. Un-awaited, and
            // AFTER the viewer has been told — see the block above.
            if (code !== 'PRECONDITION_FAILED') void utils.blocks.listMyScopeGrants.invalidate();
          })
          // `finally` rather than clearing in each arm — a spinner that outlives its mutation is
          // the failure mode a per-arm reset produces the first time a third arm is added.
          .finally(() => setPendingScope(null));
      },
    });
  };

  return { requestRevoke, pendingScope, failure };
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
