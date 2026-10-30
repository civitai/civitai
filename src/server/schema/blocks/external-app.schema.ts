/**
 * App Blocks — off-site (external-link) apps.
 *
 * PURE EXTERNAL LINK product model: a marketplace listing whose only action is
 * to open an external URL in a new tab. NO install, NO scopes, NO block token,
 * NO subscription, NO on-platform iframe/page hosting. The presence of
 * `externalUrl` on the AppBlock row is the discriminator (no separate appType
 * enum). Because there is nothing hosted on-platform, registering an external
 * app SKIPS the bundle / `<slug>.<APPS_DOMAIN>` validation the embedded-app
 * approve flow runs — there's nothing on-platform to validate.
 *
 * Mutual exclusivity: an external app must NOT also declare an on-platform
 * surface (a page or any iframe/target slot). The validator below is the single
 * source of truth for both the https:// shape check AND the
 * external-vs-on-platform conflict, so the schema, the service, and the tests
 * can't drift.
 */

/** Max length for a stored external URL (defensive bound; well above any real URL). */
export const MAX_EXTERNAL_URL_LENGTH = 2048;

export type ExternalUrlValidation =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * Validate a candidate external-link URL. Returns the parsed (whitespace-trimmed)
 * https:// URL string on success, or a human-readable error.
 *
 * NOTE: the returned `url` is the WHATWG-parsed serialization of the input, NOT a
 * sanitized/canonicalized safe URL — it is only guaranteed to be an https URL with
 * a host and NO embedded credentials. It is NOT DNS-resolved and NOT SSRF-checked;
 * a server-side fetch of it must still go through the hardened `safeFetch`.
 *
 * Rules (deterministic, no heuristics):
 *   - parses as an absolute URL,
 *   - scheme is EXACTLY https (http / javascript / data / mailto / etc. are
 *     rejected — a marketplace card link opens in the user's browser, so a
 *     non-https or non-http scheme is a phishing / XSS vector),
 *   - has a host,
 *   - carries NO userinfo (`user:pass@host`) — `https://example.com@evil.com`
 *     displays as `example.com` but resolves to `evil.com`, a display-vs-real-host
 *     phishing vector; reject it outright,
 *   - within the length bound.
 */
export function validateExternalUrl(raw: unknown): ExternalUrlValidation {
  if (typeof raw !== 'string') return { ok: false, error: 'externalUrl must be a string' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: 'externalUrl must not be empty' };
  if (trimmed.length > MAX_EXTERNAL_URL_LENGTH) {
    return { ok: false, error: `externalUrl must be ≤ ${MAX_EXTERNAL_URL_LENGTH} chars` };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: `externalUrl "${trimmed}" is not a valid absolute URL` };
  }
  // `URL.protocol` includes the trailing colon.
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: `externalUrl must be an https:// URL (got "${parsed.protocol}//")` };
  }
  if (!parsed.host) {
    return { ok: false, error: 'externalUrl must include a host' };
  }
  // Reject embedded credentials — `https://example.com@evil.com` renders the
  // trusted-looking `example.com` but the REAL host is `evil.com`.
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'externalUrl must not contain credentials (user:pass@host)' };
  }
  return { ok: true, url: parsed.toString() };
}

// ---------------------------------------------------------------------------
// SOURCE REPOSITORY URL — the optional "this app is open source, here is the
// code" link on a store listing (`AppListing.sourceRepoUrl`).
// ---------------------------------------------------------------------------

/**
 * Max length of a stored source-repository URL.
 *
 * 🔴 DELIBERATELY MUCH TIGHTER than {@link MAX_EXTERNAL_URL_LENGTH} (2048), and the
 * order of the two checks in {@link validateRepositoryUrl} is load-bearing: this bound
 * is applied BEFORE delegating, or the looser external bound would decide first and
 * this constant would never reject anything. A normalised repo URL is
 * `https://<host>/<owner>/<repo>` — a host from a three-entry allowlist plus two path
 * segments — so 200 is already far above anything real.
 */
export const MAX_REPOSITORY_URL_LENGTH = 200;

/**
 * The ONLY hosts a source-repository link may point at.
 *
 * 🔴 AN EXACT-HOST ALLOWLIST, NOT A SUFFIX MATCH. The link is rendered on a public
 * store page, so a suffix test (`endsWith('github.com')`) would admit
 * `raw.githubusercontent.com`, `gist.github.com` and `evil-github.com` alike — the
 * first two serve attacker-authored content under a trusted-looking name, and the
 * third is simply a different domain. Compared against `URL.hostname`, which the
 * WHATWG parser has already lower-cased and punycode-encoded, so `GITHUB.COM`
 * matches and a homoglyph domain (`gіthub.com`, Cyrillic і → `xn--github-fmc.com`)
 * does not.
 */
export const REPOSITORY_HOST_ALLOWLIST = ['github.com', 'gitlab.com', 'codeberg.org'] as const;

/**
 * Characters permitted in an `<owner>` / `<repo>` path segment. Deliberately narrow —
 * all three forges restrict these to ASCII word characters plus `.`/`-`/`_`, and a
 * segment carrying anything else (a percent-escape, a `@`, a `:`) is not a repo root.
 */
const REPO_PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validate + NORMALISE a public source-repository URL.
 *
 * Built ON TOP of {@link validateExternalUrl} rather than beside it, so the https-only
 * / has-a-host / no-embedded-credentials rules have exactly ONE implementation. On top
 * of those it additionally requires:
 *   - a length within {@link MAX_REPOSITORY_URL_LENGTH} (checked FIRST — see that
 *     constant's note),
 *   - no port,
 *   - a host that is EXACTLY one of {@link REPOSITORY_HOST_ALLOWLIST},
 *   - a path of EXACTLY two segments, `/<owner>/<repo>` — so the host root, a
 *     single-segment path, and a deep link (`/owner/repo/tree/main`) are all rejected.
 *
 * 🔴 THE RETURN VALUE IS CANONICAL, and that is not cosmetic: the off-site material-
 * change check compares a proposed value against the live one to decide whether an edit
 * must re-enter moderator review. Comparing raw strings would report
 * `https://github.com/a/b/` → `https://github.com/a/b.git` as a MATERIAL change (a
 * pointless mod re-review) while any two spellings of a genuinely different repo look
 * equally different. So a trailing slash, a trailing `.git`, a query string and a
 * fragment are all dropped, and the host is emitted lower-cased.
 *
 * Returns the same `{ok:true,url} | {ok:false,error}` shape as `validateExternalUrl`.
 */
export function validateRepositoryUrl(raw: unknown): ExternalUrlValidation {
  if (typeof raw !== 'string') return { ok: false, error: 'sourceRepoUrl must be a string' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: 'sourceRepoUrl must not be empty' };
  // BEFORE delegating — `validateExternalUrl`'s bound is 10x looser, so checking after
  // would make this constant unreachable. See MAX_REPOSITORY_URL_LENGTH.
  if (trimmed.length > MAX_REPOSITORY_URL_LENGTH) {
    return { ok: false, error: `sourceRepoUrl must be ≤ ${MAX_REPOSITORY_URL_LENGTH} chars` };
  }

  // Inherit https-only / has-a-host / no-credentials from the single source of truth.
  // Its messages name `externalUrl`; re-label the FIRST occurrence so the author sees
  // the field they actually filled in.
  const base = validateExternalUrl(trimmed);
  if (!base.ok) return { ok: false, error: base.error.replace('externalUrl', 'sourceRepoUrl') };

  let parsed: URL;
  try {
    parsed = new URL(base.url);
  } catch {
    // Unreachable in practice (`base.url` came out of a successful parse); keeps the
    // function total rather than relying on that.
    return { ok: false, error: `sourceRepoUrl "${trimmed}" is not a valid absolute URL` };
  }

  if (parsed.port) {
    return { ok: false, error: 'sourceRepoUrl must not specify a port' };
  }

  const host = parsed.hostname.toLowerCase();
  if (!(REPOSITORY_HOST_ALLOWLIST as readonly string[]).includes(host)) {
    return {
      ok: false,
      error: `sourceRepoUrl host "${host}" is not an accepted source host (${REPOSITORY_HOST_ALLOWLIST.join(
        ', '
      )})`,
    };
  }

  const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length !== 2) {
    return {
      ok: false,
      error: `sourceRepoUrl must point at a repository root (https://${host}/<owner>/<repo>)`,
    };
  }
  const owner = segments[0];
  // A trailing `.git` is the clone spelling of the same repo — strip it so the two
  // spellings normalise to one value. Case-insensitive, and only as a SUFFIX.
  const repo = segments[1].replace(/\.git$/i, '');
  if (repo.length === 0 || !REPO_PATH_SEGMENT_RE.test(owner) || !REPO_PATH_SEGMENT_RE.test(repo)) {
    return {
      ok: false,
      error: `sourceRepoUrl must point at a repository root (https://${host}/<owner>/<repo>)`,
    };
  }

  // Canonical form — host lower-cased, no trailing slash, no `.git`, no query/fragment.
  return { ok: true, url: `https://${host}/${owner}/${repo}` };
}

/**
 * Minimal manifest shape an external-link registration may carry. An external
 * app is a pure listing, so the only honoured fields are display metadata. A
 * `page` object or any `targets` entry means the publisher is declaring an
 * on-platform surface — which is mutually exclusive with the external-link
 * model and must be rejected (NOT silently dropped, so the publisher isn't
 * surprised later when the on-platform surface they declared doesn't exist).
 */
export type ExternalAppManifestInput = {
  name?: unknown;
  description?: unknown;
  page?: unknown;
  targets?: unknown;
  iframe?: unknown;
};

export type ExternalManifestValidation =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Assert a manifest does NOT declare any on-platform hosting surface. Used at
 * external-app registration: an external app links OUT, so a page / iframe /
 * target slot is a contradiction.
 */
export function assertNoOnPlatformSurface(manifest: ExternalAppManifestInput): ExternalManifestValidation {
  const page = manifest.page;
  if (page && typeof page === 'object') {
    return {
      ok: false,
      error: 'an external-link app must not declare a page surface (it is a standalone app)',
    };
  }
  if (Array.isArray(manifest.targets) && manifest.targets.length > 0) {
    return {
      ok: false,
      error: 'an external-link app must not declare target slots (it is a standalone app)',
    };
  }
  if (manifest.iframe && typeof manifest.iframe === 'object') {
    return {
      ok: false,
      error: 'an external-link app must not declare an iframe surface (it is a standalone app)',
    };
  }
  return { ok: true };
}
