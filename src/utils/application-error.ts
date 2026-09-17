type ApplicationErrorContext = {
  /** Short identifier for where the error came from (e.g. component name). */
  name?: string;
  /** Extra context prepended to the error message (e.g. file metadata). */
  message?: string;
  /** Overrides `error.stack` — pass React `componentStack` from an error boundary. */
  stack?: string;
  /**
   * Set `false` when the stack being sent is a REAL minified browser stack, to skip server-side
   * sourcemap resolution. See the endpoint for why this matters; the short version is that
   * resolving one is an uncached multi-megabyte read+parse on the request path, and a caller that
   * can fire once per failed render turns that into an amplifier. The stack still reaches Axiom —
   * unresolved, and resolvable offline against the `civitai-web-maps:<tag>` artifact with
   * `scripts/resolve-cpuprofile.mjs`.
   *
   * Defaults to resolving, so existing callers are unchanged: they pass a React `componentStack`,
   * which carries no file frames and is therefore a no-op for the resolver anyway.
   */
  resolveStack?: boolean;
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
    body: JSON.stringify({
      name: ctx.name,
      message,
      stack: ctx.stack ?? normalized.stack ?? '',
      // Only sent when opting OUT, so every existing caller's body is byte-identical.
      ...(ctx.resolveStack === false ? { resolveStack: false } : {}),
    }),
  }).catch(() => undefined);
}
