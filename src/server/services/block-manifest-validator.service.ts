import { validateBlockScopesAgainstOauthClient } from '~/shared/constants/block-scope.constants';
import { isKnownSlotId, isPageSlot } from '~/shared/constants/slot-registry';

type ValidationResult = { valid: true } | { valid: false; errors: string[] };

interface RawManifest {
  blockId?: unknown;
  version?: unknown;
  name?: unknown;
  contentRating?: unknown;
  renderMode?: unknown;
  trustTier?: unknown;
  scopes?: unknown;
  iframe?: {
    src?: unknown;
    minHeight?: unknown;
    maxHeight?: unknown;
    resizable?: unknown;
    sandbox?: unknown;
  };
  requiredContext?: unknown;
  assetBundleUrl?: unknown;
  /**
   * H-3: publisher-controlled allowlist of `settings` keys that listForModel
   * is allowed to expose to anonymous viewers. Anything not listed here is
   * dropped from the public response. Default (omitted/empty) = no keys
   * exposed.
   */
  publicSettingsKeys?: unknown;
  /**
   * Slot targets the app installs into (model-page slots). Each entry's
   * `slotId` MUST be a known registered slot id — previously UN-validated
   * (pre-existing gap, closed in W10).
   */
  targets?: unknown;
  /**
   * W10 — optional full-page surface descriptor. When present, the app can be
   * opened as a standalone full page at `/apps/run/<slug>`. `path` is the
   * sub-path the page mounts at (must start with `/`). `buzzBudgetPerGen` is the
   * optional per-generation Buzz budget the page's `ai:write:budgeted` tokens are
   * minted with (a page is stateless, so unlike a model slot the budget cannot
   * come from an install settings row — it comes from this manifest field,
   * server-clamped to the per-gen cap; omitted ⇒ the platform default).
   */
  page?: unknown;
  [key: string]: unknown;
}

const ALLOWED_CONTENT_RATINGS = new Set(['g', 'pg', 'pg13', 'r', 'x']);
const ALLOWED_RENDER_MODES = new Set(['iframe', 'inline', 'hybrid']);
const ALLOWED_TRUST_TIERS = new Set(['unverified', 'verified', 'internal']);

const SCOPE_RE = /^[a-z0-9_]+(?::[a-z0-9_]+){1,3}$/;

// Min/max for the iframe height envelope. The host clamps incoming
// RESIZE_IFRAME to these bounds, but rejecting absurd values at
// registration time is cheaper than fighting them at runtime.
const HEIGHT_MIN_FLOOR = 40;
const HEIGHT_MAX_CEILING = 4000;

// SSRF gate for iframe.src and assetBundleUrl. The migrate-once-fix-forever
// move is to reject hostnames that resolve to private/loopback ranges. We
// can't DNS-resolve at validation time, so we use a hostname allowlist of
// shapes we know are public: must have a dot, can't be an IP, can't be a
// reserved hostname (localhost / metadata service endpoints).
const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  // Full IPv6 ULA range fc00::/7 — the spec is fc00::/7, not fc00::/8.
  // Previously only fc00: matched; widen to fc00-fdff.
  /^f[cd][0-9a-f]{2}:/i,
  /^fe80:/i,
  // IPv6 with a zone identifier (RFC 6874 `%`-encoded) — sometimes accepted
  // by URL parsers and lets an attacker pin a literal zone like %eth0.
  /%/,
  // Reserved internal infrastructure names commonly used internally.
  /\.internal$/i,
  /\.local$/i,
  /^metadata\.google\.internal$/i,
  // Note: punycode/IDN homograph attacks (e.g. `xn--...` registered as a
  // look-alike) and DNS-rebinding (public name flipped to 127.0.0.1 at
  // fetch time) are NOT caught by lexical validation. Phase 2's
  // assetBundleUrl fetch must re-validate at fetch time and disable
  // redirect-follow. v1 doesn't fetch either URL server-side so the
  // exposure is bounded.
];

function isPublicHttpsUrl(raw: string): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'malformed URL' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'must be https' };
  const hostname = url.hostname;

  // Single-string IPv4 literals (audit B4): WHATWG URL accepts dot-less
  // forms like `0x7f000001` and `2130706433` (the integer form of 127.0.0.1)
  // and parses them to the corresponding IPv4 address. Reject these BEFORE
  // the dotted-name check below, because they don't contain dots.
  if (/^0x[0-9a-f]+$/i.test(hostname)) {
    return { ok: false, reason: 'hex IPv4 literal not permitted' };
  }
  if (/^[0-9]+$/.test(hostname)) {
    // Pure-integer form. Includes `2130706433` (= 127.0.0.1) and similar.
    return { ok: false, reason: 'integer IPv4 literal not permitted' };
  }

  // IPv4-mapped IPv6 ([::ffff:127.0.0.1] and similar) — WHATWG URL surfaces
  // these as `[::ffff:7f00:1]` style in `hostname` (lowercased, square
  // brackets kept when URL.host includes them — URL.hostname strips them).
  // Reject anything containing `::ffff:` (the IPv4-mapped prefix).
  if (/::ffff:/i.test(hostname)) {
    return { ok: false, reason: 'IPv4-mapped IPv6 not permitted' };
  }

  if (!hostname.includes('.') || hostname.endsWith('.')) {
    return { ok: false, reason: 'hostname must be a public dotted name' };
  }
  for (const re of PRIVATE_HOSTNAME_PATTERNS) {
    if (re.test(hostname)) return { ok: false, reason: 'private/internal hostname' };
  }
  // Pure-decimal-dotted IPv4 literals — keep the surface narrow even for
  // public addresses; manifests should always load by DNS name.
  if (/^[0-9.]+$/.test(hostname)) {
    return { ok: false, reason: 'literal IPv4 addresses are not permitted' };
  }
  // Dotted hex/octal IPv4 literals (e.g. 0x7f.0x0.0x0.0x1, 0177.0.0.1).
  if (/^0x[0-9a-f]+(\.0x[0-9a-f]+)+$/i.test(hostname)) {
    return { ok: false, reason: 'hex IPv4 literals are not permitted' };
  }
  if (/^0[0-7]+(\.[0-7]+)+$/.test(hostname)) {
    return { ok: false, reason: 'octal IPv4 literals are not permitted' };
  }
  return { ok: true };
}

// Sandbox is a positive allowlist gated by trust tier. Anything not listed
// is rejected even if HTML's iframe sandbox accepts it. This stops the
// well-known boundary-escape combos (allow-same-origin + allow-scripts;
// allow-popups-to-escape-sandbox; allow-top-navigation) by default.
const SANDBOX_ALLOWLIST: Record<'unverified' | 'verified' | 'internal', Set<string>> = {
  // M-POPUPS (audit medium / app-exploits-user): `allow-popups` is dropped from
  // the unverified tier. With it, any approved-but-unverified block could
  // window.open() an arbitrary URL from a visually-trusted `.civit.ai`
  // subdomain — a credential-phishing surface. Popups stay available to the
  // verified/internal tiers (mod-vetted publishers) only.
  unverified: new Set(['allow-scripts', 'allow-forms']),
  verified: new Set([
    'allow-scripts',
    'allow-forms',
    'allow-popups',
    'allow-modals',
    'allow-pointer-lock',
    'allow-downloads',
  ]),
  internal: new Set([
    'allow-scripts',
    'allow-forms',
    'allow-popups',
    'allow-modals',
    'allow-pointer-lock',
    'allow-downloads',
    'allow-same-origin',
  ]),
};

function validateSandbox(
  sandbox: string,
  trustTier: 'unverified' | 'verified' | 'internal',
  errors: string[]
) {
  const tokens = sandbox.split(/\s+/).filter(Boolean);
  // M5: an effectively empty sandbox attribute (e.g. " " or "\t") would
  // otherwise pass with zero errors. The blank-string spec means "no
  // permissions," which is fine — but explicitly require at least one
  // token so manifest authors don't accidentally ship a permissions-empty
  // sandbox attribute when they meant the property entirely omitted.
  if (tokens.length === 0) {
    errors.push('iframe.sandbox must contain at least one token');
    return;
  }
  const allowed = SANDBOX_ALLOWLIST[trustTier];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (!allowed.has(token)) {
      errors.push(`sandbox token "${token}" is not allowed for trustTier=${trustTier}`);
    }
  }
  // Defense in depth: explicit boundary-escape combos that should never
  // pass even if a future allowlist expansion adds the individual tokens.
  if (seen.has('allow-same-origin') && seen.has('allow-scripts') && trustTier !== 'internal') {
    errors.push(
      'sandbox MUST NOT combine allow-same-origin with allow-scripts outside internal trust tier'
    );
  }
}

/**
 * Validates a block manifest at registration time.
 *
 * Performs semantic validation that goes beyond raw JSON Schema:
 *   - scope strings are colon-separated lowercase (rejects PascalCase, etc.)
 *   - sandbox does not combine allow-same-origin with allow-scripts
 *   - sandbox does not include allow-top-navigation
 *   - requested scopes are a subset of `oauthClient.allowedScopes`
 *   - renderMode `inline` or `hybrid` requires trust tier `verified`/`internal`
 */
export interface AppContext {
  /** OauthClient.allowedScopes bitmask — used for scope-subset validation. */
  allowedScopes: number;
  /**
   * OauthClient.allowedOrigins normalized to lowercase scheme://host. H8:
   * iframe.src and assetBundleUrl must be hosted on an origin the registrant
   * actually controls. Empty array = no manifest URL can pass.
   */
  allowedOrigins: string[];
}

function normalizeOriginLoose(raw: string): string | null {
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function urlOriginIfPublic(raw: string): string | null {
  const r = isPublicHttpsUrl(raw);
  if (!r.ok) return null;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

export class BlockManifestValidator {
  // Back-compat overload: the existing test suite passes a bitmask number.
  // Real callers pass the AppContext shape (with allowedOrigins) so the
  // H8 binding check actually runs.
  static validate(manifest: unknown, app: AppContext | number): ValidationResult {
    const ctx: AppContext =
      typeof app === 'number'
        ? { allowedScopes: app, allowedOrigins: [] }
        : app;
    const errors: string[] = [];
    const oauthClientAllowedScopes = ctx.allowedScopes;

    if (!manifest || typeof manifest !== 'object') {
      return { valid: false, errors: ['manifest must be a JSON object'] };
    }
    const m = manifest as RawManifest;

    if (typeof m.blockId !== 'string' || m.blockId.length === 0) {
      errors.push('blockId must be a non-empty string');
    }
    if (typeof m.version !== 'string' || m.version.length === 0) {
      errors.push('version must be a non-empty string');
    }
    if (typeof m.name !== 'string' || m.name.length === 0) {
      errors.push('name must be a non-empty string');
    }

    if (typeof m.contentRating !== 'string' || !ALLOWED_CONTENT_RATINGS.has(m.contentRating)) {
      errors.push(`contentRating must be one of ${[...ALLOWED_CONTENT_RATINGS].join(', ')}`);
    }

    const renderMode = (m.renderMode as string | undefined) ?? 'iframe';
    if (!ALLOWED_RENDER_MODES.has(renderMode)) {
      errors.push(`renderMode must be one of ${[...ALLOWED_RENDER_MODES].join(', ')}`);
    }
    const trustTier = (m.trustTier as string | undefined) ?? 'unverified';
    if (!ALLOWED_TRUST_TIERS.has(trustTier)) {
      errors.push(`trustTier must be one of ${[...ALLOWED_TRUST_TIERS].join(', ')}`);
    }

    if ((renderMode === 'inline' || renderMode === 'hybrid') && trustTier === 'unverified') {
      errors.push('INLINE_REQUIRES_VERIFIED_TIER');
    }

    if (!Array.isArray(m.scopes)) {
      errors.push('scopes must be an array of strings');
    } else {
      for (const scope of m.scopes) {
        if (typeof scope !== 'string') {
          errors.push('scopes entries must be strings');
          continue;
        }
        if (!SCOPE_RE.test(scope)) {
          errors.push(`scope "${scope}" must be lowercase colon-separated (e.g. models:read:self)`);
        }
      }
      const blockScopes = (m.scopes as unknown[]).filter(
        (s): s is string => typeof s === 'string'
      );
      const scopeCheck = validateBlockScopesAgainstOauthClient(
        blockScopes,
        oauthClientAllowedScopes
      );
      if (!scopeCheck.valid) {
        errors.push(
          `requested scopes exceed OAuth client allowedScopes: ${scopeCheck.rejectedScopes.join(', ')}`
        );
      }
    }

    // H8: build the app-bound origin allowlist. Manifest URLs (iframe.src,
    // assetBundleUrl) must be on origins the registrant actually controls,
    // not arbitrary HTTPS endpoints. Without this binding, anyone with
    // JOB_TOKEN access could register a manifest pointing at
    // `https://victim.civitai.com/` and impersonate the victim app at
    // token-issuance time.
    const allowedOriginSet = new Set(
      ctx.allowedOrigins.map((o) => normalizeOriginLoose(o)).filter((s): s is string => !!s)
    );
    function checkAppOriginBinding(field: string, raw: string) {
      const origin = urlOriginIfPublic(raw);
      if (!origin) return; // already failed isPublicHttpsUrl earlier
      if (allowedOriginSet.size === 0) {
        errors.push(`${field} rejected: app has no allowedOrigins registered`);
        return;
      }
      if (!allowedOriginSet.has(origin)) {
        errors.push(
          `${field} rejected: origin ${origin} not in OauthClient.allowedOrigins`
        );
      }
    }

    // assetBundleUrl is a v2 surface but ships in the manifest blob today.
    // Validate it now so Phase 2 can fetch the bundle without re-validation
    // (stored SSRF: http://169.254.169.254/...).
    if (m.assetBundleUrl !== undefined) {
      if (typeof m.assetBundleUrl !== 'string') {
        errors.push('assetBundleUrl must be a string');
      } else {
        const check = isPublicHttpsUrl(m.assetBundleUrl);
        if (!check.ok) errors.push(`assetBundleUrl rejected: ${check.reason}`);
        else checkAppOriginBinding('assetBundleUrl', m.assetBundleUrl);
      }
    }

    // H-3: publicSettingsKeys is an optional allowlist of `settings` keys
    // that listForModel is allowed to echo to anonymous viewers. Each key
    // must be a plain string; empty/omitted = no public exposure. We cap
    // the array length so a malicious manifest can't slowly bloat the
    // response shape.
    if (m.publicSettingsKeys !== undefined) {
      if (!Array.isArray(m.publicSettingsKeys)) {
        errors.push('publicSettingsKeys must be an array of strings');
      } else if (m.publicSettingsKeys.length > 32) {
        errors.push('publicSettingsKeys must contain at most 32 entries');
      } else {
        for (const k of m.publicSettingsKeys) {
          if (typeof k !== 'string' || k.length === 0 || k.length > 64) {
            errors.push('publicSettingsKeys entries must be non-empty strings ≤64 chars');
            break;
          }
        }
      }
    }

    if (!m.iframe || typeof m.iframe !== 'object') {
      // For renderMode=inline+verified, iframe may be omitted in v2. v1: require iframe.
      if (renderMode === 'iframe') errors.push('iframe block is required for renderMode=iframe');
    } else {
      const iframe = m.iframe;
      if (typeof iframe.src !== 'string') {
        errors.push('iframe.src must be a string');
      } else {
        const check = isPublicHttpsUrl(iframe.src);
        if (!check.ok) errors.push(`iframe.src rejected: ${check.reason}`);
        else checkAppOriginBinding('iframe.src', iframe.src);
      }
      if (
        typeof iframe.minHeight !== 'number' ||
        iframe.minHeight < HEIGHT_MIN_FLOOR ||
        iframe.minHeight > HEIGHT_MAX_CEILING
      ) {
        errors.push(
          `iframe.minHeight must be a number in [${HEIGHT_MIN_FLOOR}, ${HEIGHT_MAX_CEILING}]`
        );
      }
      if (
        iframe.maxHeight !== null &&
        (typeof iframe.maxHeight !== 'number' ||
          iframe.maxHeight < HEIGHT_MIN_FLOOR ||
          iframe.maxHeight > HEIGHT_MAX_CEILING)
      ) {
        errors.push(
          `iframe.maxHeight must be null or a number in [${HEIGHT_MIN_FLOOR}, ${HEIGHT_MAX_CEILING}]`
        );
      }
      if (
        typeof iframe.minHeight === 'number' &&
        typeof iframe.maxHeight === 'number' &&
        iframe.maxHeight < iframe.minHeight
      ) {
        errors.push('iframe.maxHeight must be ≥ iframe.minHeight');
      }
      if (typeof iframe.resizable !== 'boolean') {
        errors.push('iframe.resizable must be a boolean');
      }
      const tierForSandbox = (ALLOWED_TRUST_TIERS.has(trustTier)
        ? trustTier
        : 'unverified') as 'unverified' | 'verified' | 'internal';
      if (typeof iframe.sandbox !== 'string' || iframe.sandbox.length === 0) {
        errors.push('iframe.sandbox must be a non-empty string');
      } else {
        validateSandbox(iframe.sandbox, tierForSandbox, errors);
      }
    }

    // W10 (+ pre-existing gap closure): validate `targets[].slotId`. Each target
    // must be an object whose `slotId` is a KNOWN registered slot id. This was
    // previously UN-validated — a manifest could declare an arbitrary slot
    // string that listForModel / the registry would never match (silent
    // mis-install). Optional (a page-only app may have no model targets).
    if (m.targets !== undefined) {
      if (!Array.isArray(m.targets)) {
        errors.push('targets must be an array');
      } else {
        if (m.targets.length > 16) {
          errors.push('targets must contain at most 16 entries');
        }
        for (const t of m.targets) {
          if (!t || typeof t !== 'object') {
            errors.push('each target must be an object');
            continue;
          }
          const slotId = (t as { slotId?: unknown }).slotId;
          if (typeof slotId !== 'string' || slotId.length === 0) {
            errors.push('each target must carry a non-empty slotId string');
            continue;
          }
          if (!isKnownSlotId(slotId)) {
            errors.push(`target slotId "${slotId}" is not a known slot`);
            continue;
          }
          // A model-page target must be a model (region) slot, not the page
          // slot — the page surface is declared via the `page` field, not a
          // `targets` entry.
          if (isPageSlot(slotId)) {
            errors.push(`target slotId "${slotId}" is the page slot — declare a full page via the "page" field, not targets`);
          }
        }
      }
    }

    // W10 — validate the optional `page` descriptor. When present it must be an
    // object with a string `path` that starts with '/'; `title` is required
    // (shown in the host chrome) and `icon` is an optional string. A page app
    // also needs an iframe.src (validated above) — that is the bundle the page
    // route iframes.
    if (m.page !== undefined) {
      if (!m.page || typeof m.page !== 'object' || Array.isArray(m.page)) {
        errors.push('page must be an object');
      } else {
        const page = m.page as {
          path?: unknown;
          title?: unknown;
          icon?: unknown;
          buzzBudgetPerGen?: unknown;
        };
        if (typeof page.path !== 'string' || page.path.length === 0) {
          errors.push('page.path must be a non-empty string');
        } else if (!page.path.startsWith('/')) {
          errors.push('page.path must start with "/"');
        } else if (page.path.length > 256) {
          errors.push('page.path must be ≤256 chars');
        }
        if (typeof page.title !== 'string' || page.title.length === 0) {
          errors.push('page.title must be a non-empty string');
        } else if (page.title.length > 128) {
          errors.push('page.title must be ≤128 chars');
        }
        if (page.icon !== undefined && (typeof page.icon !== 'string' || page.icon.length > 128)) {
          errors.push('page.icon must be a string ≤128 chars');
        }
        // W10 generation spend — optional per-gen Buzz budget for the page's
        // `ai:write:budgeted` tokens. Must be a positive, finite integer when
        // present (the mint handler clamps it to BUZZ_BUDGET_CAP, so an over-cap
        // value isn't rejected here — it's silently capped at issuance — but a
        // non-positive / non-integer / non-finite value is a manifest bug).
        if (page.buzzBudgetPerGen !== undefined) {
          const b = page.buzzBudgetPerGen;
          if (typeof b !== 'number' || !Number.isFinite(b) || !Number.isInteger(b) || b <= 0) {
            errors.push('page.buzzBudgetPerGen must be a positive integer');
          }
        }
        // A page app must ship an iframe block (the bundle the full page mounts).
        if (!m.iframe || typeof m.iframe !== 'object') {
          errors.push('a manifest declaring "page" must also declare an iframe block');
        }
      }
    }

    return errors.length === 0 ? { valid: true } : { valid: false, errors };
  }
}
