import { TRPCError } from '@trpc/server';

/**
 * Binds a verified block token to the signed-in session for bridge writes that run as
 * `protectedProcedure`s: the session proves who is at the keyboard, the token proves which app
 * and install is asking, and the two must name the same person.
 *
 * A leaf (one import, nothing anyone mocks) rather than a home in `block-scope.middleware`, which
 * the router suites `vi.mock` wholesale: an export added there resolves to `undefined` in exactly
 * the suites that drive these refusals. Same reasoning as `block-token-subject.ts`.
 */

/** The default refusal when a block token's subject is not the session user. */
export const BLOCK_SUBJECT_NOT_SESSION_USER_MESSAGE =
  'this app session belongs to a different account; reload the page to continue';

/**
 * Throws FORBIDDEN unless `subjectUserId` (the verified token's parsed `sub`) is the session
 * user. `null` (an anonymous or unparseable subject) never matches. `message` replaces the
 * default text for a caller with its own refusal copy.
 */
export function assertBlockSubjectIsSessionUser(
  subjectUserId: number | null,
  sessionUserId: number,
  message: string = BLOCK_SUBJECT_NOT_SESSION_USER_MESSAGE
): void {
  if (subjectUserId !== sessionUserId) {
    throw new TRPCError({ code: 'FORBIDDEN', message });
  }
}
