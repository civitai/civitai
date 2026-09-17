type ApplicationErrorContext = {
  /** Short identifier for where the error came from (e.g. component name). */
  name?: string;
  /** Extra context prepended to the error message (e.g. file metadata). */
  message?: string;
  /** Overrides `error.stack` — pass React `componentStack` from an error boundary. */
  stack?: string;
  /**
   * Set `false` when the stack being sent is a REAL minified browser stack, to skip server-side
   * sourcemap resolution. See the endpoint for what that resolution costs; the short version is a
   * read and parse of the chunk and its map per distinct frame file, on the request path. The
   * server caps and caches that work, so this is a saving rather than the only thing standing
   * between a caller and unbounded cost — worth setting on a path that can fire once per failed
   * render, not worth thinking about on a path that fires once per user action.
   *
   * The stack still reaches Axiom, just unresolved. Resolving it afterwards needs the BROWSER maps
   * for that build: they are emitted (`productionBrowserSourceMaps`, `next.config.mjs`) as sibling
   * `.js.map` files under the build's `static` directory, and that directory IS copied into the
   * runtime image — they are the same files the server-side resolver reads. So the maps for a
   * declined stack are in the image that produced it, and that is where a later resolution gets
   * them. Two things it is NOT: the `civitai-web-maps:<tag>` artifact holds only the server maps
   * (see the `maps` target in the `Dockerfile`), and `scripts/resolve-cpuprofile.mjs` takes a V8
   * `.cpuprofile`, not a stack string. No checked-in script resolves a stack string today.
   *
   * Defaults to resolving, so every existing caller is unchanged.
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
