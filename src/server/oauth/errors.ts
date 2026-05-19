/**
 * Thrown from `oauthModel.getClient` when a public client's request Origin
 * isn't in the client's registered `allowedOrigins`. Caught by the /token
 * handler to emit a structured 403 + `origin.rejected` audit log without a
 * pre-library DB lookup.
 */
export class OriginNotAllowedError extends Error {
  constructor(public clientId: string, public origin: string | undefined) {
    super('Origin is not in the registered allowedOrigins for this client.');
    this.name = 'OriginNotAllowedError';
  }
}
