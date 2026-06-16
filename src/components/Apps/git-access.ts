/**
 * Pure helper for the Phase 3 "Author via git" panel (AuthorViaGit.tsx).
 * Extracted so the credential-masking logic is unit-testable without React.
 *
 * `blocks.getMyAppRepo` returns a clone URL with the push token embedded as the
 * basic-auth password:
 *   https://<username>:<token>@<host>/<org>/<slug>.git
 * The panel renders this MASKED by default so the live token isn't in the DOM on
 * first paint; this helper produces the masked display string. The REAL URL is
 * still what the copy button copies — masking is display-only.
 */

const TOKEN_MASK = '••••••••';

/**
 * Replaces the password (token) segment of a `user:token@host` clone URL with a
 * fixed mask, preserving the username and everything from `@host` onward so the
 * shape is still recognizable. Returns the input unchanged if it doesn't carry
 * an embedded `user:pass@` credential (nothing to mask, fail-safe — never throws).
 */
export function maskCloneUrlCredential(cloneUrl: string): string {
  // Match scheme + userinfo (user:pass) + the rest. Only mask when BOTH a colon
  // (a password is present) and an '@' (it's really userinfo, not a host:port)
  // are in the authority. Non-greedy user/pass; the '@' anchors the credential.
  const m = cloneUrl.match(/^(\w+:\/\/)([^:/@\s]+):([^@\s]+)@(.+)$/);
  if (!m) return cloneUrl;
  const [, scheme, user, , rest] = m;
  return `${scheme}${user}:${TOKEN_MASK}@${rest}`;
}
