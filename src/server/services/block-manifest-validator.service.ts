import {
  isKnownBlockScope,
  validateBlockScopesAgainstOauthClient,
} from '~/shared/constants/block-scope.constants';
import { isKnownSlotId, isPageSlot } from '~/shared/constants/slot-registry';
import {
  MARKETPLACE_CATEGORIES,
  isMarketplaceCategory,
} from '~/server/services/blocks/marketplace-categories.constants';
// The lexical SSRF hostname guards were EXTRACTED to a shared, dependency-free
// module (no `node:dns`, so this validator stays client-bundle-safe — it is
// imported by `ManifestEditForm.tsx`). `safe-fetch.ts` imports the same helpers,
// so the manifest validator and the fetch-time guard share ONE source of truth.
import { isPublicHttpsUrl } from '~/server/utils/ssrf-hostname';

type ValidationResult = { valid: true } | { valid: false; errors: string[] };

interface RawManifest {
  blockId?: unknown;
  version?: unknown;
  name?: unknown;
  contentRating?: unknown;
  renderMode?: unknown;
  trustTier?: unknown;
  scopes?: unknown;
  /**
   * OPTIONAL marketplace category. When present it MUST be a member of
   * `MARKETPLACE_CATEGORIES` (single-sourced with the const + the published
   * schema's `category` enum). It flows to the app's `/apps` store listing on
   * moderator-approve (populated onto `AppBlock.category` only when a moderator
   * hasn't already curated one — see `approveRequest`). Absent is fine.
   */
  category?: unknown;
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
  /**
   * Config-as-code (CLI `page-vite` template). OPTIONAL + backward-compatible —
   * manifests without these still validate. The datapacket-talos build recipe
   * that HONORS these is a separate follow-up; the validator only has to ACCEPT
   * them so the CLI's generated manifest isn't rejected at submit time.
   *
   * `buildCommand` — the command the build sandbox runs to produce the bundle.
   *   SECURITY: dev-supplied + executes in the build sandbox (gotcha #61: the
   *   sandbox is already unprivileged, network-isolated, credential-less). The
   *   shape-allowlist below is DEFENSE-IN-DEPTH against pipeline/YAML/shell
   *   injection — it bounds the string to a small set of known-safe build
   *   invocations and rejects shell metacharacters, so even if the sandbox were
   *   weakened the command can't fan out into arbitrary shell.
   * `outputDir` — the relative dir the build emits into (served as the bundle).
   *   Must be a safe RELATIVE path (no leading '/', no '..' traversal). Default
   *   `dist` when omitted.
   */
  buildCommand?: unknown;
  outputDir?: unknown;
  [key: string]: unknown;
}

export const ALLOWED_CONTENT_RATINGS = new Set(['g', 'pg', 'pg13', 'r', 'x']);
export const ALLOWED_RENDER_MODES = new Set(['iframe', 'inline', 'hybrid']);
export const ALLOWED_TRUST_TIERS = new Set(['unverified', 'verified', 'internal']);

const SCOPE_RE = /^[a-z0-9_]+(?::[a-z0-9_]+){1,3}$/;

// CANONICAL blockId rule (single-sourced with the published schema at
// https://civitai.com/schemas/app-block/v1.json and the `civitai` CLI). blockId
// becomes the per-app subdomain `<blockId>.civit.ai` (see manifest-normalize.ts /
// APPS_DOMAIN), so it MUST be a valid DNS label: lowercase a–z/0–9/hyphen, must
// start with a letter, must not start or end with a hyphen, 3–40 chars.
const BLOCK_ID_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/;
const BLOCK_ID_MIN_LENGTH = 3;
const BLOCK_ID_MAX_LENGTH = 40;

// CANONICAL version rule: semantic version `x.y.z` with an optional
// `-prerelease` suffix. Single-sourced with the published schema + the CLI.
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// Config-as-code `buildCommand` shape allowlist (defense-in-depth — see the
// field comment in RawManifest). The build sandbox is already isolated; this
// keeps the command AUDITABLE + bounds it to a small, documented set of safe
// build invocations so a dev-supplied string can't smuggle a shell pipeline or
// YAML/command injection into the build recipe.
//
// Accepted shapes (anchored, no surrounding whitespace permitted):
//   - `npm run <script>` / `pnpm run <script>` / `yarn run <script>`
//     where <script> is a package.json script name: [a-zA-Z0-9:_-]+
//   - `vite build` or `npx vite build`
// Anything else — extra args, flags, shell metacharacters, multiple commands —
// is rejected. The separate SHELL_METACHAR_RE below is a redundant second gate
// so the rejection reason is explicit when a metachar is what tripped it.
const BUILD_COMMAND_MAX_LENGTH = 128;
const BUILD_COMMAND_RE =
  /^(?:(?:npm|pnpm|yarn) run [a-zA-Z0-9:_-]+|(?:npx )?vite build)$/;
// Shell metacharacters that must never appear in a buildCommand. Checked first
// so the error is specific ("contains shell metacharacters") rather than the
// generic allowlist-miss message.
const SHELL_METACHAR_RE = /[;|&$`<>(){}\\!*?\[\]'"\n\r]/;

// Min/max for the iframe height envelope. The host clamps incoming
// RESIZE_IFRAME to these bounds, but rejecting absurd values at
// registration time is cheaper than fighting them at runtime.
const HEIGHT_MIN_FLOOR = 40;
const HEIGHT_MAX_CEILING = 4000;

// SSRF gate for iframe.src and assetBundleUrl. `isPublicHttpsUrl` (and the
// `PRIVATE_HOSTNAME_PATTERNS` it uses) live in `~/server/utils/ssrf-hostname` (a
// shared, dependency-free module) so this validator, the read-path anchors, and
// the fetch-time guard in `safe-fetch.ts` can't drift. It is PURELY LEXICAL — a
// server-side fetch of one of these URLs must additionally DNS-resolve + check
// every address at fetch time (see safe-fetch.ts).

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

    // blockId becomes the per-app subdomain `<blockId>.civit.ai`, so it must be
    // a DNS-label-safe slug (canonical rule, single-sourced with the published
    // schema + the CLI): lowercase, starts with a letter, no leading/trailing
    // hyphen, a–z/0–9/hyphen only, 3–40 chars.
    if (typeof m.blockId !== 'string') {
      errors.push('blockId must be a string');
    } else if (
      m.blockId.length < BLOCK_ID_MIN_LENGTH ||
      m.blockId.length > BLOCK_ID_MAX_LENGTH ||
      !BLOCK_ID_RE.test(m.blockId)
    ) {
      errors.push(
        'blockId must be 3–40 chars, lowercase, start with a letter, and contain only a–z, 0–9, hyphen (it becomes <blockId>.civit.ai)'
      );
    }
    // version must be a semantic version (canonical rule, single-sourced).
    if (typeof m.version !== 'string') {
      errors.push('version must be a string');
    } else if (!VERSION_RE.test(m.version)) {
      errors.push('version must be semver (e.g. 1.0.0)');
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

    // Optional marketplace `category`. When present it must be one of the known
    // MARKETPLACE_CATEGORIES (referenced directly — never a second hardcoded
    // copy, so the validator, the const, and the published schema's `category`
    // enum can't drift). Absent is fine (a moderator can categorise later). On
    // approve, a present+valid category is copied onto AppBlock.category only
    // when a moderator hasn't already curated one (see approveRequest), so it
    // flows to the auto-created store listing. Mirrors how the offsite
    // submission path validates its taxonomy category.
    if (m.category !== undefined && !isMarketplaceCategory(m.category)) {
      errors.push(`category must be one of ${MARKETPLACE_CATEGORIES.join(', ')}`);
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
          continue;
        }
        // Membership check (canonical, single-sourced): the scope must be one of
        // the known block scopes (BLOCK_SCOPE_TO_OAUTH_BIT — the authoritative
        // set). A well-formed-but-unknown scope (e.g. models:read:all) is
        // rejected here rather than silently ignored downstream.
        if (!isKnownBlockScope(scope)) {
          errors.push(`scope "${scope}" is not a known block scope`);
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

    // Config-as-code: buildCommand (optional). dev-supplied + runs in the build
    // sandbox — shape-constrain it (defense-in-depth) to a documented allowlist
    // and reject shell metacharacters. Optional + backward-compatible: a manifest
    // without buildCommand still validates.
    if (m.buildCommand !== undefined) {
      if (typeof m.buildCommand !== 'string') {
        errors.push('buildCommand must be a string');
      } else if (m.buildCommand.length === 0) {
        errors.push('buildCommand must be a non-empty string');
      } else if (m.buildCommand.length > BUILD_COMMAND_MAX_LENGTH) {
        errors.push(`buildCommand must be ≤${BUILD_COMMAND_MAX_LENGTH} chars`);
      } else if (SHELL_METACHAR_RE.test(m.buildCommand)) {
        errors.push('buildCommand must not contain shell metacharacters');
      } else if (!BUILD_COMMAND_RE.test(m.buildCommand)) {
        errors.push(
          'buildCommand must match an allowed build invocation ' +
            '(e.g. "npm run build", "pnpm run <script>", "vite build", "npx vite build")'
        );
      }
    }

    // Config-as-code: outputDir (optional). A safe RELATIVE path the build emits
    // into. No leading '/', no '..' traversal, no backslashes / NUL. Default is
    // `dist` (applied downstream when omitted — the validator only enforces the
    // shape of an explicit value). Optional + backward-compatible.
    if (m.outputDir !== undefined) {
      if (typeof m.outputDir !== 'string') {
        errors.push('outputDir must be a string');
      } else if (m.outputDir.length === 0) {
        errors.push('outputDir must be a non-empty string');
      } else if (m.outputDir.length > 256) {
        errors.push('outputDir must be ≤256 chars');
      } else if (m.outputDir.startsWith('/')) {
        errors.push('outputDir must be a relative path (no leading "/")');
      } else if (
        // Reject any path traversal segment ('..'), backslash separators, NUL,
        // and Windows drive prefixes (C:\). Split on both separators so a
        // `foo/../bar` or `foo\..\bar` traversal is caught regardless of OS form.
        m.outputDir.includes('\0') ||
        m.outputDir.includes('\\') ||
        /(^|\/)\.\.(\/|$)/.test(m.outputDir) ||
        /^[a-zA-Z]:/.test(m.outputDir)
      ) {
        errors.push('outputDir must not contain path traversal ("..") or absolute/Windows paths');
      }
    }

    return errors.length === 0 ? { valid: true } : { valid: false, errors };
  }
}
