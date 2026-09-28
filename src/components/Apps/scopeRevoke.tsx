import { Badge, Button, Group, Stack, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { useState } from 'react';
import type { ScopeConsentState } from '~/components/Apps/scopeConsentRows';
import { fixedScopeNote } from '~/components/Apps/scopeConsentRows';
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
 * The ONE scope in the vocabulary that can spend the viewer's Buzz.
 *
 * Lives here rather than as a second local const in `src/pages/apps/activity.tsx` (which is
 * where it used to be, and which now imports it) because BOTH the budget editor and the revoke
 * confirm copy need it: revoking it CLEARS the stored daily limit, which the dialog has to say.
 */
export const SPEND_SCOPE = 'ai:write:budgeted';

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
  scope: string;
  message: string;
  degraded: boolean;
};

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

  const mutation = trpc.blocks.revokeScopes.useMutation({
    onSuccess: async (_data, variables) => {
      await utils.blocks.listMyScopeGrants.invalidate();
      showSuccessNotification({
        title: 'Permission removed',
        message: `${appName} can no longer use ${variables.scopes.join(', ')}.`,
      });
    },
    onError: async (error, variables) => {
      const code = error.data?.code;
      const degraded = code === 'SERVICE_UNAVAILABLE';
      // See the docblock: 412 is the only outcome the server states left the row untouched.
      if (code !== 'PRECONDITION_FAILED') await utils.blocks.listMyScopeGrants.invalidate();
      setFailure({ scope: variables.scopes[0] ?? '', message: error.message, degraded });
      if (degraded) {
        // A WARNING, not an error: the permission is gone. The notification and the inline
        // notice carry the same server sentence rather than two paraphrases of it.
        showWarningNotification({ title: 'Permission removed', message: error.message });
      }
    },
    // `onSettled` rather than clearing in each arm — a spinner that outlives its mutation is
    // the failure mode a per-arm reset produces the first time a third arm is added.
    onSettled: () => setPendingScope(null),
  });

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
        mutation.mutate({ appBlockId, scopes: [scope] });
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
