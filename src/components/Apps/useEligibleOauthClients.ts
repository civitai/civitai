import { useMemo } from 'react';
import { isAppBlockOauthClientId } from '~/shared/constants/block-scope.constants';
import { trpc } from '~/utils/trpc';

/** The projection of an OAuth client both submit surfaces need. */
export type EligibleOauthClient = { id: string; name: string; allowedScopes: number };

/**
 * Tri-state, because "we don't know yet" and "you have none" must NEVER collapse.
 *
 * 🔴 This is the whole point of the type. A pending fetch rendered as a confirmed
 * empty list is the measured defect this module exists to make unrepresentable: it
 * would tell a developer who owns three OAuth clients that they own none, at the very
 * moment they are choosing how to list their app. `'unknown'` covers BOTH loading and
 * error — an errored query is equally not evidence of absence, and the honest UI for
 * both is the same: say nothing about the prerequisite.
 */
export type EligibleOauthClientsState =
  | { status: 'unknown'; clients: readonly EligibleOauthClient[]; hasEligibleClient: null }
  | { status: 'ready'; clients: readonly EligibleOauthClient[]; hasEligibleClient: boolean };

/**
 * 🔒 THE ONE ELIGIBILITY PREDICATE for "an OAuth client this author may list".
 *
 * `oauthClient.getAll` is already scoped to the caller (`userId`), so ownership is
 * the server's job; the client-side rule is the App-Block exclusion — an
 * auto-provisioned App-Block client is managed by the App Blocks flow and is never a
 * hand-authored listing target.
 *
 * ## Why a shared hook rather than two `useQuery` calls
 *
 * The prerequisite is now surfaced in TWO places — the mode selector (before any work)
 * and the wizard's step-2 empty state (defence in depth, because a client can be
 * deleted mid-flow). Open-coding the filter at both would let them disagree, which is
 * precisely how the selector could invite a developer into a flow that then dead-ends.
 * They share one query key too, so the selector's fetch warms the wizard's.
 */
export function useEligibleOauthClients(): EligibleOauthClientsState {
  const query = trpc.oauthClient.getAll.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const clients = useMemo(
    () =>
      ((query.data ?? []) as EligibleOauthClient[]).filter((c) => !isAppBlockOauthClientId(c.id)),
    [query.data]
  );

  // 🔴 Branch on "did the fetch SETTLE with data", not on `isLoading`. A query that
  // is disabled, errored, or paused is not loading and has no data — and every one of
  // those states must read as `unknown`, never as an empty list.
  const settled = query.data !== undefined;
  if (!settled) return { status: 'unknown', clients: [], hasEligibleClient: null };
  return { status: 'ready', clients, hasEligibleClient: clients.length > 0 };
}
