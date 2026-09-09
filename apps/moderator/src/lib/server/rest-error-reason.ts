/**
 * The refusal a main-app endpoint wrote for the operator, read out of its JSON error body.
 *
 * 🔴 TWO ENVELOPE SHAPES REACH THIS APP, and reading only one of them silently destroys the reason.
 * `defineModeratorEndpoint` hands a throw to the main app's `handleEndpointError`
 * (`src/server/utils/endpoint-helpers.ts`), and that helper emits:
 *
 *   - `{ error, message, code }` — every `restErrorBody(...)` path, which is what the 5xx branch and
 *     the genericized-4xx branch use;
 *   - `{ message }` alone — the 4xx/503 PASS-THROUGH branch, i.e. exactly the statuses that carry a
 *     refusal somebody wrote FOR a human (`throwBadRequestError`, `throwNotFoundError`, …).
 *
 * Reading `error` only therefore came back `null` for the entire second group, and the caller fell
 * back to `"<label> returned <status>."` — the status with the reason stripped off it. Measured on
 * #4609: a moderator ruling on an already-ruled restriction saw "Restriction ruling returned 400."
 * That is the same class of loss as the opaque 500 the endpoint change was made to remove, one layer
 * further out.
 *
 * The fix is here rather than in `handleEndpointError` deliberately. That helper is the shared
 * chokepoint for 36 REST route files, its 4xx and 503 pass-through bodies are pinned
 * `toStrictEqual({ message })` by `endpoint-helpers-error-envelope.test.ts` (the 503 case as an
 * explicit, documented carve-out), and `restErrorBody` needs a `RestErrorCode` that is not derivable
 * at that point without a new status→code map — which would then have to be reconciled with the
 * closed key ledger `rest-error-envelope-ledger.test.ts` enforces. Widening the reader costs one
 * expression and makes every endpoint's 4xx legible here; widening the emitter changes the wire
 * format of 36 routes.
 *
 * 🔴 This module is deliberately IMPORT-FREE, for the same reason
 * `apps/moderator/src/lib/restriction-types.ts` is: the main app's Vitest project loads it across the
 * app boundary by filesystem path, so that the seam between the emitter and this reader can be
 * driven end-to-end in ONE process
 * (`src/server/__tests__/pending-review-mute.test.ts`). Two suites that each mock the other side
 * would both pass over exactly the divergence above. Keep it import-free.
 */
export function restErrorReason(body: unknown, status: number): string | null {
  const b = (body ?? null) as Record<string, unknown> | null;
  const reason =
    typeof b?.error === 'string'
      ? b.error
      : // The 4xx/503 pass-through shape. Second, not first: where both keys exist they are the same
      // string (`restErrorBody` defaults `error` to `message`), so the order is only about which
      // one wins if they ever diverge, and `error` is the older contract.
      typeof b?.message === 'string'
      ? b.message
      : null;
  if (!reason) return null;
  const retry = b?.retryAfterSeconds;
  return status === 429 && typeof retry === 'number' ? `${reason} — retry in ${retry}s.` : reason;
}
