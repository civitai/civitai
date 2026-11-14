import type { TRPCDefaultErrorShape, TRPCError } from '@trpc/server';
import { getClientSafeError } from '~/server/trpc/client-safe-error';
import { rateLimitMetaOf } from '~/server/utils/rate-limit-error';

export function errorFormatter({
  shape,
  error,
}: {
  shape: TRPCDefaultErrorShape;
  error: TRPCError;
}) {
  const formatted = formatShape(shape, error);
  const rateLimit = rateLimitMetaOf(error);
  if (!rateLimit) return formatted;
  return { ...formatted, data: { ...formatted.data, rateLimit } };
}

function formatShape(shape: TRPCDefaultErrorShape, error: TRPCError) {
  // `cause.softBlock` is set only by the generation gate (auditPromptServer)
  // and read only by the generator form. Keep it off the message: consumers
  // match that with `startsWith`.
  const cause = error.cause as
    | { softBlock?: boolean; tosReacceptRequired?: boolean; consentRevokeRecorded?: boolean }
    | undefined;
  if (cause?.softBlock === true) {
    return { ...shape, data: { ...shape.data, softBlock: true } };
  }
  // The client opens the ToS modal on this rather than showing the refusal — see
  // `server/common/tos-reacceptance.ts`. Off the message, same reason as softBlock.
  if (cause?.tosReacceptRequired === true) {
    return { ...shape, data: { ...shape.data, tosReacceptRequired: true } };
  }
  // Set only by `blocks.revokeScopes` when the grant row WAS written and only the in-flight
  // marker failed. The revoke UI reports "Permission removed" on this flag alone: a bare 503 can
  // also be the database being unreachable BEFORE the write (the `mapDbUnavailable` middleware),
  // and that one removed nothing. Lifted on a 503 only: returning here skips the client-safe
  // rewrite below, which a 503 never needs and a 500 always does.
  if (cause?.consentRevokeRecorded === true && error.code === 'SERVICE_UNAVAILABLE') {
    return { ...shape, data: { ...shape.data, consentRevokeRecorded: true } };
  }
  const safe = getClientSafeError(error);
  if (safe) {
    return { ...shape, message: safe.message, data: { ...shape.data, errorRef: safe.errorRef } };
  }
  return shape;
}
