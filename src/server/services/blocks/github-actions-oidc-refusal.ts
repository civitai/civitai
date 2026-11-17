/**
 * The error a GitHub Actions OIDC token refusal throws, in a module with no imports so the submit
 * routes can recognise it in their error path without loading the verifier (jose, Flipt, the
 * feature-flag service). Thrown by `verifyGithubActionsOidcToken` in `github-actions-oidc.service.ts`.
 */

export type ActionsOidcRefusalReason =
  | 'malformed'
  | 'signature'
  | 'issuer'
  | 'audience'
  | 'expired'
  | 'invalid-claims'
  | 'missing-claim'
  | 'not-a-push'
  | 'not-a-tag'
  | 'tag-version-mismatch'
  | 'sha-mismatch'
  | 'replayed'
  | 'repository-mismatch'
  | 'unavailable';

/**
 * A token the submit refuses. `status` 400 = the token or the pipeline is wrong (do not retry the
 * same way); 409 = the token is from a different repository than the app is pinned to; 503 = a dependency (GitHub's key set, the replay store) could not answer, so re-run the
 * workflow. The message never includes the token.
 */
export class GithubActionsOidcRefusal extends Error {
  readonly reason: ActionsOidcRefusalReason;
  readonly status: 400 | 409 | 503;
  constructor(reason: ActionsOidcRefusalReason, detail: string, status: 400 | 409 | 503 = 400) {
    super(`GitHub Actions OIDC token rejected: ${detail}`);
    this.name = 'GithubActionsOidcRefusal';
    this.reason = reason;
    this.status = status;
  }
}

export function isGithubActionsOidcRefusal(err: unknown): err is GithubActionsOidcRefusal {
  return err instanceof GithubActionsOidcRefusal;
}
