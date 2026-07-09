type ApplicationErrorContext = {
  /** Short identifier for where the error came from (e.g. component name). */
  name?: string;
  /** Extra context prepended to the error message (e.g. file metadata). */
  message?: string;
  /** Overrides `error.stack` — pass React `componentStack` from an error boundary. */
  stack?: string;
};

/**
 * Reports a client-side error to `/api/application-error`, which forwards to Axiom
 * (prod only) with sourcemapped stack, userId, url, and user-agent attached server-side.
 * Fire-and-forget: never throws, so it's safe to call from a catch block.
 */
export function reportApplicationError(error: unknown, ctx: ApplicationErrorContext = {}) {
  const normalized =
    error instanceof Error
      ? error
      : new Error(typeof error === 'string' ? error : 'Unknown application error');
  const message = ctx.message ? `${ctx.message} | ${normalized.message}` : normalized.message;

  return fetch('/api/application-error', {
    method: 'POST',
    body: JSON.stringify({ name: ctx.name, message, stack: ctx.stack ?? normalized.stack ?? '' }),
  }).catch(() => undefined);
}
