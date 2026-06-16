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
 * Replaces the password (token) segment of any `scheme://user:token@host`
 * credential with a fixed mask, preserving the username + host + path. Works on
 * a bare clone URL AND on a multi-line string that EMBEDS one (e.g. the
 * `git clone <url>` instructions snippet) — every occurrence is masked. Only
 * masks when both a colon (a password) and an `@` are present in the userinfo,
 * with no `/` or whitespace inside (so it never mangles a `host:port` or a URL
 * without credentials). Returns the input unchanged when there's nothing to mask
 * (fail-safe — never throws).
 */
export function maskCloneUrlCredential(text: string): string {
  return text.replace(
    /(\w+:\/\/)([^:/@\s]+):([^@\s]+)@/g,
    (_full, scheme, user) => `${scheme}${user}:${TOKEN_MASK}@`
  );
}
