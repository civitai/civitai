import {
  APP_REACTION_ENTITY_TYPES,
  APP_REACTION_READ_MAX_IDS,
  APP_REACTION_SCOPE,
  APP_REACTION_SERVER_ERRORS,
  REACT_TICKET_MAX_LENGTH,
  isAppImageReaction,
  type AppImageReaction,
  type AppReactionEntityType,
  type EntityReactionError,
} from '~/shared/constants/block-reaction.constants';

/**
 * SET_ENTITY_REACTION / GET_ENTITY_REACTIONS — the shared, PURE decision layer for the app
 * reactions bridge. Imported by BOTH real hosts (IframeHost.tsx and PageBlockHost.tsx, which do
 * not share handlers) so the refusals, the payload contract and the server-error mapping exist
 * once. Modelled on `collectionFollowGate.ts`.
 *
 * ── HOW THIS DIFFERS FROM THE FOLLOW BRIDGE ─────────────────────────────────
 *
 * Follow's per-action host confirm is the only consent that path has, because its scope is
 * consent-exempt. A confirm per ♥ tap would make reactions unusable, so this bridge has NONE:
 * its consent is the consent-gated `social:react:self` grant, made once per app through the
 * existing consent flow. A host that has not been granted the scope refuses with
 * `needs-consent` before any network call, and the server refuses the same request on its own
 * if a host ever forgets to.
 *
 * Both procedures take the block token AND the viewer's session: the server proves the token's
 * subject IS the signed-in viewer, so a token cannot react for anyone else.
 *
 * ── THE CONTRACT ─────────────────────────────────────────────────────────────
 *
 * REQUEST-style both ways, so EVERY path replies exactly once (`createReactionReplyLatch`) with
 * either a `result` or an `error` from the CLOSED set in `ENTITY_REACTION_ERRORS`. Only a
 * payload with no usable `requestId` is dropped: there is nothing to reply to.
 */

export type EntityReactionSetRequest = {
  requestId: string;
  entityType: AppReactionEntityType;
  entityId: number;
  reaction: AppImageReaction;
  reacted: boolean;
  ticket?: string;
};

export type EntityReactionsGetRequest = {
  requestId: string;
  entityType: AppReactionEntityType;
  ids: number[];
  tickets?: Record<string, string>;
};

export type ReactionGateResult<TRequest> =
  | { kind: 'drop' }
  | { kind: 'refuse'; requestId: string; error: EntityReactionError }
  | { kind: 'proceed'; request: TRequest };

type GateInputs = {
  raw: unknown;
  /** Has the block completed its handshake (host gate status `ready`)? */
  ready: boolean;
  /** Is a real session user present in the host? */
  signedIn: boolean;
  /**
   * Any mod-review sandbox, run-for-real or not. The scope is withheld from BOTH review
   * allowlists, so a review token can never carry it; refusing here names the reason instead
   * of letting the server's scope refusal read as `needs-consent`.
   */
  reviewMode: boolean;
  /** The scopes the minted token actually carries (`resolveAdvertisedScopes`). */
  grantedScopes: readonly string[];
};

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isEntityType(v: unknown): v is AppReactionEntityType {
  return typeof v === 'string' && (APP_REACTION_ENTITY_TYPES as readonly string[]).includes(v);
}

function isTicket(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= REACT_TICKET_MAX_LENGTH;
}

/**
 * The refusals both messages share, in order: review mode, then the handshake, then the
 * viewer. Identity before payload, as on the follow bridge, so an anonymous caller is refused
 * as anonymous rather than as malformed. Consent is checked by each resolver AFTER payload
 * validation, so a malformed request without the grant reads `invalid-request`.
 */
function preflight(
  obj: Record<string, unknown>,
  inputs: GateInputs
): { requestId: string; error?: EntityReactionError } | null {
  if (typeof obj.requestId !== 'string' || obj.requestId.length === 0) return null;
  const requestId = obj.requestId;
  if (inputs.reviewMode) return { requestId, error: 'review-mode' };
  if (!inputs.ready) return { requestId, error: 'not-ready' };
  if (!inputs.signedIn) return { requestId, error: 'sign-in-required' };
  return { requestId };
}

export function resolveSetEntityReactionRequest(
  inputs: GateInputs
): ReactionGateResult<EntityReactionSetRequest> {
  const { raw } = inputs;
  if (!raw || typeof raw !== 'object') return { kind: 'drop' };
  const obj = raw as Record<string, unknown>;
  const pre = preflight(obj, inputs);
  if (!pre) return { kind: 'drop' };
  const { requestId } = pre;
  if (pre.error) return { kind: 'refuse', requestId, error: pre.error };

  if (
    !isEntityType(obj.entityType) ||
    !isPositiveInt(obj.entityId) ||
    !isAppImageReaction(obj.reaction) ||
    typeof obj.reacted !== 'boolean' ||
    (obj.ticket !== undefined && !isTicket(obj.ticket))
  ) {
    return { kind: 'refuse', requestId, error: 'invalid-request' };
  }
  if (!inputs.grantedScopes.includes(APP_REACTION_SCOPE)) {
    return { kind: 'refuse', requestId, error: 'needs-consent' };
  }
  return {
    kind: 'proceed',
    request: {
      requestId,
      entityType: obj.entityType,
      entityId: obj.entityId,
      reaction: obj.reaction,
      reacted: obj.reacted,
      ...(obj.ticket !== undefined ? { ticket: obj.ticket as string } : {}),
    },
  };
}

export function resolveGetEntityReactionsRequest(
  inputs: GateInputs
): ReactionGateResult<EntityReactionsGetRequest> {
  const { raw } = inputs;
  if (!raw || typeof raw !== 'object') return { kind: 'drop' };
  const obj = raw as Record<string, unknown>;
  const pre = preflight(obj, inputs);
  if (!pre) return { kind: 'drop' };
  const { requestId } = pre;
  if (pre.error) return { kind: 'refuse', requestId, error: pre.error };

  const ids = obj.ids;
  if (
    !isEntityType(obj.entityType) ||
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > APP_REACTION_READ_MAX_IDS ||
    !ids.every(isPositiveInt)
  ) {
    return { kind: 'refuse', requestId, error: 'invalid-request' };
  }
  let tickets: Record<string, string> | undefined;
  if (obj.tickets !== undefined) {
    if (!obj.tickets || typeof obj.tickets !== 'object' || Array.isArray(obj.tickets)) {
      return { kind: 'refuse', requestId, error: 'invalid-request' };
    }
    tickets = {};
    // Only the tickets for ids actually requested travel to the server; the rest are noise
    // a block could use to inflate the request.
    const wanted = new Set(ids.map(String));
    for (const [key, value] of Object.entries(obj.tickets as Record<string, unknown>)) {
      if (!wanted.has(key)) continue;
      if (!isTicket(value)) return { kind: 'refuse', requestId, error: 'invalid-request' };
      tickets[key] = value;
    }
  }
  if (!inputs.grantedScopes.includes(APP_REACTION_SCOPE)) {
    return { kind: 'refuse', requestId, error: 'needs-consent' };
  }
  return {
    kind: 'proceed',
    request: {
      requestId,
      entityType: obj.entityType,
      ids: [...new Set(ids as number[])],
      ...(tickets ? { tickets } : {}),
    },
  };
}

/**
 * Map a thrown server error onto the closed set. Matches on the tRPC code and on the server's
 * OWN refusal strings (`APP_REACTION_SERVER_ERRORS`), never on free text from elsewhere; every
 * error that is not one of those — the site handler's contest window, an entity the viewer may
 * not react to, an owner who blocked the viewer, an expired ticket, the kill switch — is
 * `entity-unavailable`. A network failure lands there too: the block can retry, and there is no
 * truthful finer code to give it.
 */
export function classifyEntityReactionError(err: unknown): EntityReactionError {
  const message =
    err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message
      : '';
  const data = err && typeof err === 'object' ? (err as { data?: unknown }).data : undefined;
  const code =
    data && typeof data === 'object' && typeof (data as { code?: unknown }).code === 'string'
      ? (data as { code: string }).code
      : '';
  if (code === 'TOO_MANY_REQUESTS') return 'rate-limited';
  if (code === 'UNAUTHORIZED') return 'sign-in-required';
  if (message === APP_REACTION_SERVER_ERRORS.missingScope) return 'needs-consent';
  if (message === APP_REACTION_SERVER_ERRORS.reactionNotAllowed) return 'invalid-request';
  return 'entity-unavailable';
}

/** Exactly-once reply for one request. Every later call is a no-op. */
export function createReactionReplyLatch({
  requestId,
  emit,
}: {
  requestId: string;
  emit: (payload: Record<string, unknown>) => void;
}): { reply: (payload: { result: unknown } | { error: EntityReactionError }) => void } {
  let settled = false;
  return {
    reply: (payload) => {
      if (settled) return;
      settled = true;
      emit({ requestId, ...payload });
    },
  };
}
