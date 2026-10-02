import type { TRPCDefaultErrorShape, TRPCError } from '@trpc/server';
import { getClientSafeError } from '~/server/trpc/client-safe-error';

export function errorFormatter({
  shape,
  error,
}: {
  shape: TRPCDefaultErrorShape;
  error: TRPCError;
}) {
  // `cause.softBlock` is set only by the generation gate (auditPromptServer)
  // and read only by the generator form. Keep it off the message: consumers
  // match that with `startsWith`.
  const cause = error.cause as { softBlock?: boolean; tosReacceptRequired?: boolean } | undefined;
  if (cause?.softBlock === true) {
    return { ...shape, data: { ...shape.data, softBlock: true } };
  }
  // The client opens the ToS modal on this rather than showing the refusal — see
  // `server/common/tos-reacceptance.ts`. Off the message, same reason as softBlock.
  if (cause?.tosReacceptRequired === true) {
    return { ...shape, data: { ...shape.data, tosReacceptRequired: true } };
  }
  const safe = getClientSafeError(error);
  if (safe) {
    return { ...shape, message: safe.message, data: { ...shape.data, errorRef: safe.errorRef } };
  }
  return shape;
}
