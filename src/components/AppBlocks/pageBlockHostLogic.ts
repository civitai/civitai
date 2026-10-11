// Pure logic for PageBlockHost (W10 full-page apps). Extracted so the two
// security/UX-load-bearing decisions are unit-testable in the node vitest env
// (no RTL — civitai-web's unit project runs `environment: 'node'` and only
// collects `*.test.ts`). Mirrors the IframeHost `hostRenderDecision` pattern.

import { isKnownBlockScope } from '~/shared/constants/block-scope.constants';
import { maxInitPostsWithin } from './iframeInitController';
import type { HostStatus } from './openBuzzPurchaseGate';

export type PageHostStatus = 'loading' | 'ready' | 'timeout' | 'fatal' | 'no_token' | 'error';

/**
 * Collapse PageBlockHost's local `Status` onto the shared `HostStatus` union the
 * status-gated message handlers speak: `resolveRequestConsent`,
 * `resolveBuzzPurchaseRequest`, `resolveRequestSignIn`, the inline
 * OPEN_IMAGE_UPLOAD gate, and NAVIGATE.
 *
 * PageBlockHost carries one extra terminal variant — `'error'`, a hard mint
 * failure — that the shared union does not model. Every gate opens ONLY on
 * `'ready'` and `'error'` is a disjoint terminal state (the iframe isn't even
 * rendered), so mapping it to another non-ready sentinel is semantics-preserving:
 * the gate would return null either way. This just satisfies the union type.
 *
 * ONE RULE, ONE PLACE. This shim used to be open-coded at four of those call
 * sites (NAVIGATE hand-rolled a fifth, slightly different comparison). N copies of
 * a predicate is N chances to fix N−1 of them; it is centralised here so the
 * mapping is unit-testable and can only ever be changed in one place. Callers read
 * it through PageBlockHost's `readGateStatus`, which additionally sources the
 * status from a render-body-updated ref rather than a stale effect closure.
 */
export function toHostGateStatus(status: PageHostStatus): HostStatus {
  return status === 'error' ? 'no_token' : status;
}

/**
 * #3/#6: the scopes the minted page JWT ACTUALLY carries — the page manifest's
 * declared scopes minus the consent-gated ones the viewer hasn't granted
 * (`missingScopes`, reported by the mint). The server signs exactly this set,
 * so this is what BLOCK_INIT / TOKEN_REFRESH must advertise to the block.
 * Posting `[]` (the old hardcode) lied to the block about its capabilities
 * (a page token carries `apps:storage:*`). Mirrors IframeHost.grantedScopes.
 */
export function grantedPageScopes(
  declaredScopes: string[],
  missingScopes: string[] | undefined
): string[] {
  if (!missingScopes || missingScopes.length === 0) return declaredScopes;
  const withheld = new Set(missingScopes);
  return declaredScopes.filter((s) => !withheld.has(s));
}

// 🔴 `resolveUngrantableConsentNotice` + `UngrantableConsentNotice` MOVED OUT of
// this module, to `requestConsentGate.ts`. They were never page-specific: they are
// the REFUSAL half of the gate `resolveRequestConsent` opens, and both host
// surfaces need them. While they lived here the model-slot host (`IframeHost`) —
// which deliberately does NOT import this module, the page host being a sibling
// surface rather than a dependency — emitted no CONSENT_UNAVAILABLE at all, so a
// block that asked got a `requestGrants` promise that could never resolve `false`.
// Do NOT re-add a copy here; import from the gate.

/** What a reviewMode REQUEST_CONSENT should surface to the moderator. */
export type ReviewConsentNotice = {
  /** Whether the mod gets a (passive, non-interactive) notice at all. */
  notify: boolean;
  /**
   * The requested scopes safe to NAME in that notice: the un-granted subset,
   * filtered to the known block-scope vocabulary. Empty ⇒ use generic copy.
   */
  scopes: string[];
};

/**
 * MOD REVIEW SANDBOX — decide what a `reviewMode` REQUEST_CONSENT tells the
 * moderator. The review host NEVER opens a consent modal (a grant would re-mint
 * the mod's token with WIDER scopes at the request of unapproved code), and the
 * review mint deliberately strips the app's scopes — so in review a consent
 * round-trip can NEVER resolve. Dropping it silently (the old behaviour) left the
 * app parked on its consent card with zero feedback at the reviewer.
 *
 * Differs from `resolveUngrantableConsentNotice` (now in `requestConsentGate`) in
 * exactly one way, and that difference is the bug this fixes: with NO usable
 * `scopes` hint the prod path
 * must stay silent (it can't tell "already granted" from "clamped"), but in
 * review there is nothing to tell apart — consent is structurally unavailable, so
 * a hint-less request is still a dead end and still deserves the notice. (The
 * SDK's `useRequestConsent()` is fire-and-forget and need not send a hint at all.)
 *
 * The one case that stays SILENT is the benign one the hint proves: every
 * requested scope is already granted, so nothing is actually blocked.
 *
 * 🔴 `rawScopesHint` is UNTRUSTED (it comes from the reviewed app's own frame, via
 * its manifest). The returned `scopes` are therefore filtered through
 * `isKnownBlockScope`, so only the fixed platform vocabulary can ever reach a
 * moderator-facing string — an attacker can't smuggle arbitrary display text into
 * a toast aimed at the reviewer. (Callers must still render it as React text.)
 * That claim depends on `isKnownBlockScope` being an OWN-property test: it used
 * to use `in`, which walks the prototype chain and let 12 inherited
 * `Object.prototype` keys (`constructor`, `__proto__`, `toString`, …) through as
 * "known scopes". Fixed at the predicate; the unit tests below pin it here too,
 * because THIS is the caller that feeds untrusted runtime input to it.
 */
export function resolveReviewConsentNotice(
  rawScopesHint: unknown,
  grantedScopes: string[]
): ReviewConsentNotice {
  const requested = Array.isArray(rawScopesHint)
    ? rawScopesHint.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];
  if (requested.length === 0) return { notify: true, scopes: [] };

  const granted = new Set<string>(grantedScopes);
  const ungranted = Array.from(new Set(requested.filter((s) => !granted.has(s)))).sort();
  // Benign: the block re-requested scopes it already holds — nothing is blocked.
  if (ungranted.length === 0) return { notify: false, scopes: [] };

  return { notify: true, scopes: ungranted.filter((s) => isKnownBlockScope(s)) };
}

/**
 * Emit latch for the review consent notice — the ANTI-SPAM bound.
 *
 * `shown` — any notice has been emitted this mount.
 * `named` — the emitted notice NAMED at least one scope (the informative one).
 */
export type ReviewConsentLatch = { shown: boolean; named: boolean };

export const INITIAL_REVIEW_CONSENT_LATCH: ReviewConsentLatch = { shown: false, named: false };

/**
 * 🔴 ANTI-SPAM, and the reason it is not a plain boolean.
 *
 * The reviewed app is UNTRUSTED code that can post `REQUEST_CONSENT` in a loop,
 * so the notice MUST be bounded per host mount. A plain "already notified"
 * boolean bounded it to one — but at the cost of first-notice-wins: the SDK's
 * `useRequestConsent()` takes an OPTIONAL `scopes` hint, so a hint-less request
 * on load is an ordinary path, not an edge case. That first request produced the
 * generic "requested a permission it doesn't have here" copy, set the latch, and
 * then permanently suppressed the app's LATER, specific `['buzz:read:self']`
 * request. The moderator never learned WHICH permission — defeating the point of
 * naming scopes at all.
 *
 * So the latch tracks whether a scope-NAMED notice has been shown, and allows
 * exactly ONE upgrade generic → named.
 *
 * BOUND (this is the security property, and it is why the transitions are
 * written as an explicit state machine): at most TWO notices per host mount.
 *   - `named` set        ⇒ never show again (the best notice is already up);
 *   - `shown && !isNamed` ⇒ never show again (a repeat generic adds nothing).
 * Every accepted transition sets `shown`, and only a `!named → named` step can
 * follow an accepted generic — so the accept sequence is at most
 * `generic, named`. A flood of any mix is capped at 2, not 2-per-distinct-scope.
 */
export function advanceReviewConsentLatch(
  latch: ReviewConsentLatch,
  isNamed: boolean
): { show: boolean; next: ReviewConsentLatch } {
  // The informative notice is already up — nothing left to tell the reviewer.
  if (latch.named) return { show: false, next: latch };
  // A generic notice is already up and this request names nothing new.
  if (latch.shown && !isNamed) return { show: false, next: latch };
  return { show: true, next: { shown: true, named: isNamed } };
}

/** A ready-to-render review consent notification. */
export type ReviewConsentNotification = {
  id: string;
  /**
   * The id this notice REPLACES (the generic one), or null. Non-null only on
   * the generic → named upgrade.
   */
  supersedesId: string | null;
  title: string;
  message: string;
};

/**
 * Build the moderator-facing review-consent notification.
 *
 * 🔴 THE `id` IS LOAD-BEARING, TWICE.
 *
 * (1) MODE-SPECIFIC. Mantine's `showNotification` is a NO-OP when a notification
 * with the same id is already displayed or queued (default autoClose 4000ms). A
 * single `review-consent-<appBlockId>` id was therefore identical across
 * render-only and run-for-real — so the realistic sequence "notice fires in
 * render-only → mod clicks Run for real… → host remounts → latch resets by
 * design → app re-requests within 4s" SILENTLY SWALLOWED the run-for-real
 * notice, re-creating the original silent-drop bug in the other mode. The mode
 * is part of the id.
 *
 * (2) NAMED vs GENERIC. The generic → named upgrade must not be swallowed the
 * same way, and it cannot use `updateNotification` either: that only maps over
 * notifications that are still live, so once the generic has auto-closed the
 * upgrade would vanish. The named notice therefore carries its OWN id and
 * reports the generic id as `supersedesId`, which the caller passes to
 * `hideNotification` first — a harmless no-op if the generic already closed.
 * Net effect: exactly one visible notice, in BOTH timing cases.
 *
 * `scopes` must already be filtered by `resolveReviewConsentNotice` (known
 * vocabulary only); callers must render `message` as React text, never HTML.
 */
export function buildReviewConsentNotification(opts: {
  appBlockId: string;
  runForReal: boolean;
  scopes: string[];
}): ReviewConsentNotification {
  const { appBlockId, runForReal, scopes } = opts;
  const baseId = `review-consent-${appBlockId}-${runForReal ? 'real' : 'render'}`;
  const named = scopes.length > 0;

  const what = named
    ? `This app requested ${scopes.join(', ')}.`
    : 'This app requested a permission it doesn’t have here.';
  // 🔴 The opt-in is NOT free: "Run for real…" re-mints the token against the
  // MODERATOR'S OWN account and spends the MODERATOR'S OWN Buzz (it grants
  // `ai:write:budgeted` under a per-session cap). Untrusted code can emit this
  // toast unprompted right after BLOCK_READY, so the one surface that points a
  // reviewer at that opt-in must say what it costs them — pointing at a
  // spend-your-own-money button without saying so is how a hostile app gets a
  // mod to click it.
  const how = runForReal
    ? 'Review previews always run with reduced permissions.'
    : 'Review previews run with reduced permissions — use “Run for real…” (runs against your own account and Buzz) to grant the app its real permissions.';

  return {
    id: named ? `${baseId}-scoped` : baseId,
    supersedesId: named ? baseId : null,
    title: 'Permission unavailable in review',
    message: `${what} ${how}`,
  };
}

// ── OPEN_RESOURCE_PICKER (Design 1 host-chrome resource picker) ──────────────
//
// The page block asks the HOST to open its native ResourceSelectModal so the
// viewer can DISCOVER a generation resource (checkpoint / LoRA). The iframe
// never sees the catalog — only the single picked resource comes back via
// RESOURCE_PICKER_RESULT. This generalizes the model-slot OPEN_CHECKPOINT_PICKER
// (IframeHost) from Checkpoint-only to a typed allowlist.
//
// Type allowlist: Checkpoint + the generator's LoRA FAMILY (LORA, LoCon, DoRA).
// Matches the page-LoRA body contract — a LoRA-family model.type goes to
// additionalResources, Checkpoint to modelVersionId. Any other requested type is
// REJECTED (the request is dropped, the modal never opens) so a block can't open
// an embeddings/VAE/wildcards picker on a page.
//
// Why LoCon + DoRA belong here and nothing else does — this CLOSES a gap rather
// than opening one. The SPEND-time gate `PAGE_LORA_MODEL_TYPES`
// (server/services/blocks/workflow.service, enforced by `resolvePageLoraGates`)
// has always been {LORA, LoCon, DoRA} — the same set the platform's
// compatibility model groups as the LoRA family (basemodel.constants'
// `fullAddonTypes` / `sdxlCrossAddonTypes` / `sdxlSiblingAddonTypes` each list
// all three side by side). So LoCon and DoRA were already spend-legal while
// being unpickable: an author could only reach them by hard-coding a version id.
// Widening the picker to exactly that set adds no type the submit path would
// then reject, and moves NO gate — the spend-time set is untouched by this
// change. Adding a type OUTSIDE the LoRA family (VAE, TextualInversion,
// Wildcards, Upscaler, Hypernetwork, …) would be the opposite: a picker offering
// resources `resolvePageLoraGates` refuses with BAD_REQUEST.

/** Canonical model-type tokens the page resource picker accepts. */
export const PAGE_RESOURCE_PICKER_TYPES = ['Checkpoint', 'LORA', 'LoCon', 'DoRA'] as const;
export type PageResourcePickerType = (typeof PAGE_RESOURCE_PICKER_TYPES)[number];

export type ResourcePickerRequest = {
  requestId: string;
  resourceType: PageResourcePickerType;
  /** Optional base-model family hint (ecosystem key or baseModel name). */
  baseModelGroup?: string;
};

/**
 * Validate + normalize a raw OPEN_RESOURCE_PICKER payload from an untrusted
 * iframe. Returns the sanitized request, or `null` when it must be DROPPED
 * (missing/invalid requestId, missing/unsupported resourceType). Pure so the
 * security-critical type allowlist + drop rules are unit-testable in the node
 * vitest env (no RTL). The CALLER opens the native modal — this only decides
 * whether to, and with what type/family filter.
 *
 * Type acceptance is case-insensitive on the wire (a block may send 'lora' or
 * 'LoRA'); the returned `resourceType` is the canonical `ModelType` token the
 * native modal filter expects ('Checkpoint' | 'LORA' | 'LoCon' | 'DoRA').
 *
 * The returned shape is deliberately CLOSED: requestId, the canonical type and
 * an optional family hint. There is no maturity / browsing-level / sfwOnly knob
 * here and none is read off the raw payload, so widening the TYPE allowlist
 * cannot widen what a viewer is shown.
 */
export function resolveResourcePickerRequest(raw: unknown): ResourcePickerRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.requestId !== 'string' || obj.requestId.length === 0) return null;

  if (typeof obj.resourceType !== 'string') return null;
  const wanted = obj.resourceType.trim().toLowerCase();
  const canonical = PAGE_RESOURCE_PICKER_TYPES.find((t) => t.toLowerCase() === wanted);
  if (!canonical) return null; // unsupported type → reject (modal never opens)

  const baseModelGroup =
    typeof obj.baseModelGroup === 'string' && obj.baseModelGroup.length > 0
      ? obj.baseModelGroup
      : undefined;

  return {
    requestId: obj.requestId,
    resourceType: canonical,
    ...(baseModelGroup ? { baseModelGroup } : {}),
  };
}

// ── OPEN_RESOURCE_PICKER multi-select (`multiple: { max }`) ──────────────────
//
// A block that stacks several LoRAs asks for them in ONE picker session instead
// of reopening the picker per resource. This is a SEPARATE resolver, read off
// the same raw payload AFTER resolveResourcePickerRequest has accepted it, so
// that function — and the closed {requestId, resourceType, baseModelGroup?}
// shape its tests pin — is untouched: a request without `multiple` takes exactly
// the path it always has.
//
// Wire contract (mirrored by the SDK's `useResourcePicker` `multiple` option):
//   request  OPEN_RESOURCE_PICKER   { requestId, resourceType, baseModelGroup?, multiple?: { max } }
//   reply    RESOURCE_PICKER_RESULT { requestId, selectedResources: SafeGenerationResource[] }
//            — pick order; `[]` when the viewer dismissed. `selected` is NOT set.
//   refusal  RESOURCE_PICKER_RESULT { requestId, error }
// A single-pick request still answers { requestId, selected? } and nothing else,
// so the two reply shapes cannot be mistaken for one another: a list reply is
// recognisable by the `selectedResources` array, and a host that predates this
// (which never reads `multiple`, opens a single pick and answers `selected`) is
// recognisable by its absence.
//
// Rules:
//   - `multiple` absent or null → not a multi request.
//   - `max` above the cap is CLAMPED to PAGE_RESOURCE_PICKER_MULTI_MAX.
//   - `multiple` that is not `{ max: <integer ≥ 1> }` → REFUSED.
//   - a resourceType outside the LoRA family (i.e. Checkpoint) → REFUSED. A
//     generation takes one checkpoint (`body.modelVersionId`) and a list of
//     LoRA-family resources (`body.additionalResources`), so "several" only has
//     a meaning for the latter.
// A refusal is ANSWERED (with `error`) rather than dropped: only an SDK that
// knows about multi-select can send the key, and it turns an `error` reply into
// a thrown error — better than a block waiting on a picker that never opens. It
// is never downgraded to a single pick, which would hand back a different
// result shape than the one asked for.

/** The LoRA family within PAGE_RESOURCE_PICKER_TYPES — the only multi-selectable types. */
export const PAGE_RESOURCE_PICKER_MULTI_TYPES = ['LORA', 'LoCon', 'DoRA'] as const;

/**
 * Most resources ONE multi-select request can return. Equal to the page body's
 * `additionalResources` cap (`MAX_ADDITIONAL_RESOURCES` in the block workflow
 * schema — a parity test pins the two together), so a full batch is always one
 * the submit path accepts.
 */
export const PAGE_RESOURCE_PICKER_MULTI_MAX = 5;

export type ResourcePickerMultiple =
  | { kind: 'single' }
  | { kind: 'multiple'; max: number }
  | { kind: 'refused'; reason: string };

/**
 * Decide whether an ALREADY-ACCEPTED OPEN_RESOURCE_PICKER payload is a
 * multi-select request. `resourceType` is the canonical type
 * resolveResourcePickerRequest returned for the same payload. Pure — see the
 * section comment above for the rules.
 */
export function resolveResourcePickerMultiple(
  raw: unknown,
  resourceType: PageResourcePickerType
): ResourcePickerMultiple {
  const multiple =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>).multiple : undefined;
  if (multiple === undefined || multiple === null) return { kind: 'single' };

  if (!(PAGE_RESOURCE_PICKER_MULTI_TYPES as readonly string[]).includes(resourceType)) {
    return {
      kind: 'refused',
      reason: `OPEN_RESOURCE_PICKER: multiple is only supported for LoRA-family resource types, not ${resourceType}.`,
    };
  }
  const max = typeof multiple === 'object' ? (multiple as Record<string, unknown>).max : undefined;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
    return {
      kind: 'refused',
      reason: 'OPEN_RESOURCE_PICKER: multiple.max must be a whole number of at least 1.',
    };
  }
  return { kind: 'multiple', max: Math.min(max, PAGE_RESOURCE_PICKER_MULTI_MAX) };
}

/**
 * The resources a multi-select request answers with, from what the native modal
 * handed back: pick order kept, a repeated resource collapsed onto its first
 * occurrence, and never more than `max` entries. The modal already enforces
 * both while the viewer is choosing; this is the belt that keeps the reply
 * inside the request's cap whatever the modal does in future. It only ever
 * REMOVES entries — every resource returned is one the viewer picked.
 */
export function capPickedResources<T extends { id: number }>(
  picked: readonly T[],
  max: number
): T[] {
  const seen = new Set<number>();
  const out: T[] = [];
  for (const resource of picked) {
    if (out.length >= max) break;
    if (seen.has(resource.id)) continue;
    seen.add(resource.id);
    out.push(resource);
  }
  return out;
}

// ── OPEN_CHECKPOINT_PICKER (parity with the model-slot IframeHost) ────────────
//
// The SDK hook `useCheckpointPicker()` posts OPEN_CHECKPOINT_PICKER and awaits
// CHECKPOINT_PICKER_RESULT. The model-slot host (IframeHost) handles it; this
// page host historically did NOT (it only handled the newer, wider
// OPEN_RESOURCE_PICKER), so the same block that worked in the model slot — and
// in the dev:live SDK host, which DOES serve it — spun forever on a page. This
// restores dev:live↔prod parity for `useCheckpointPicker` on pages.
//
// Unlike OPEN_RESOURCE_PICKER there is no type allowlist to enforce here — the
// type is implicitly Checkpoint — so the only validation is: require a string
// requestId (drop otherwise, never open the modal) and pass through an optional
// base-model family hint. Kept pure + unit-tested for the same reason as
// resolveResourcePickerRequest (the drop rule is the security-relevant part).

export type CheckpointPickerRequest = {
  requestId: string;
  /** Optional base-model family hint (ecosystem key 'Flux1' or baseModel name 'Flux.1 D'). */
  baseModelGroup?: string;
};

/**
 * Validate + normalize a raw OPEN_CHECKPOINT_PICKER payload from an untrusted
 * iframe. Returns the sanitized request, or `null` when it must be DROPPED
 * (missing/non-string requestId). Mirrors IframeHost's inline validation; the
 * CALLER opens the native checkpoint modal — this only decides whether to, and
 * with what family filter.
 */
export function resolveCheckpointPickerRequest(raw: unknown): CheckpointPickerRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.requestId !== 'string' || obj.requestId.length === 0) return null;

  const baseModelGroup =
    typeof obj.baseModelGroup === 'string' && obj.baseModelGroup.length > 0
      ? obj.baseModelGroup
      : undefined;

  return { requestId: obj.requestId, ...(baseModelGroup ? { baseModelGroup } : {}) };
}

// ── OPEN_IMAGE_UPLOAD (host-mediated block image-upload bridge) ──────────────
//
// A block asks the HOST to open its native upload modal so the viewer can upload
// an image (the app decides what it is for). The iframe never handles the bytes.
//
// The optional `purpose` field selects the upload MODE:
//   - 'display' (DEFAULT — absent/unrecognized falls back to this, so it stays
//     byte-compatible with an SDK that sends no `purpose`): a PUBLIC image
//     (cosmetic backgrounds, cover art, …). The bytes flow through civitai's
//     session-authed upload → REAL scan → SFW/flag gate, and only a moderated
//     image id (never above the SFW ceiling, never flagged) comes back via
//     IMAGE_UPLOAD_RESULT. Everything security-relevant (scan + SFW ceiling +
//     flag rejection) is enforced server-side.
//   - 'generationSource': a PRIVATE generation INPUT (an img2img source image).
//     It uploads via the SAME lightweight consumer-blob path civitai's own
//     generator uses (uploadConsumerBlob) — NO createImage, NO scan, NO SFW
//     gate — and returns only { url, width, height }. Platform safety is
//     preserved because the ORCHESTRATOR scans the generation OUTPUT.
//
// The only wire-validation is: require a string requestId (drop otherwise, never
// open the modal) and normalize `purpose` to the safe default when unknown. Kept
// pure + unit-tested for the same reason as resolveResourcePickerRequest.

export type BlockUploadPurpose = 'display' | 'generationSource';

export type ImageUploadRequest = {
  requestId: string;
  /** Normalized upload mode; 'display' when the SDK omits/sends an unknown value. */
  purpose: BlockUploadPurpose;
  /**
   * NON-BLOCKING scan opt-in (display uploads only). When true, the host modal
   * resolves EARLY on persist (returning a PENDING handle) and streams the scan
   * verdict asynchronously to the block via the parent→block IMAGE_SCAN_RESOLVED
   * push, instead of blocking the modal on the poll gate. Normalized to `true`
   * ONLY for a literal `asyncScan === true` (any other value ⇒ false), so an old
   * SDK that sends no flag keeps the byte-compatible blocking behavior, and the
   * flag is IGNORED for generationSource (that path has no scan).
   */
  asyncScan: boolean;
};

/**
 * Validate a raw OPEN_IMAGE_UPLOAD payload from an untrusted iframe. Returns the
 * sanitized request (requestId + normalized purpose + asyncScan), or `null` when
 * it must be DROPPED (missing/non-string requestId). The CALLER opens the native
 * upload modal — this only decides whether to, which mode, and blocking-vs-async.
 * An absent or unrecognized `purpose` normalizes to the safe moderated default
 * ('display'); `asyncScan` is `true` ONLY for a literal `true` (default false).
 */
export function resolveImageUploadRequest(raw: unknown): ImageUploadRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.requestId !== 'string' || obj.requestId.length === 0) return null;
  const purpose: BlockUploadPurpose =
    obj.purpose === 'generationSource' ? 'generationSource' : 'display';
  const asyncScan = obj.asyncScan === true;
  return { requestId: obj.requestId, purpose, asyncScan };
}

// ── PUBLISH_GENERATION_OUTPUTS (Model-Benchmarking seam) ─────────────────────
// The block asks the host to PUBLISH selected outputs of one of its OWN
// workflows as bare, real-scanned public images. The wire-validation here is
// deliberately minimal (require a string requestId + a non-empty string
// workflowId; sanitize the optional index list) — the SERVER is the real
// authority (ownership guard + app-tag + it resolves the urls itself). Pure +
// unit-tested like the sibling resolvers.

export type PublishGenerationOutputsRequest = {
  requestId: string;
  workflowId: string;
  /** Sanitized to a list of non-negative integers; absent when the block omitted it. */
  imageIndexes?: number[];
  /** Optional advisory title (trimmed of non-string). */
  title?: string;
};

/**
 * Validate a raw PUBLISH_GENERATION_OUTPUTS payload from an untrusted iframe.
 * Returns the sanitized request, or `null` when it must be DROPPED (missing
 * requestId or a missing/empty workflowId — nothing legitimate to publish). Note
 * the block sends INDEXES, never urls: the host resolves urls server-side, so the
 * iframe can't inject an arbitrary blob.
 */
export function resolvePublishGenerationOutputsRequest(
  raw: unknown
): PublishGenerationOutputsRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.requestId !== 'string' || obj.requestId.length === 0) return null;
  if (typeof obj.workflowId !== 'string' || obj.workflowId.length === 0) return null;
  const req: PublishGenerationOutputsRequest = {
    requestId: obj.requestId,
    workflowId: obj.workflowId,
  };
  if (Array.isArray(obj.imageIndexes)) {
    const indexes = obj.imageIndexes.filter(
      (n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0
    );
    // Only carry a NON-EMPTY selection — an empty (or all-garbage) array means
    // "publish all", identical to omitting the field (never a BAD_REQUEST).
    if (indexes.length > 0) req.imageIndexes = indexes;
  }
  if (typeof obj.title === 'string') req.title = obj.title;
  return req;
}

// ── GET_IMAGES_BY_IDS (Model-Benchmarking seam) ──────────────────────────────
// The block asks the host for per-viewer gated display data for a set of image
// ids. The host self-binds the viewer + applies the clamp server-side; the
// resolver just sanitizes the id list (positive integers) so a garbage payload
// never reaches the server schema (which requires ≥1 id) — the caller replies
// with an empty result for an empty/garbage list rather than hanging the block.

export type GetImagesByIdsRequest = {
  requestId: string;
  /** Sanitized to a list of positive integers (may be empty). */
  imageIds: number[];
};

/**
 * Validate a raw GET_IMAGES_BY_IDS payload from an untrusted iframe. Returns the
 * sanitized request (requestId + filtered positive-integer imageIds), or `null`
 * when it must be DROPPED (missing/non-string requestId). An empty `imageIds`
 * after filtering is a valid (empty-result) request, NOT a drop.
 */
export function resolveGetImagesByIdsRequest(raw: unknown): GetImagesByIdsRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.requestId !== 'string' || obj.requestId.length === 0) return null;
  const imageIds = Array.isArray(obj.imageIds)
    ? obj.imageIds.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0)
    : [];
  return { requestId: obj.requestId, imageIds };
}

// ── NAVIGATE (#5209) ─────────────────────────────────────────────────────────
// A block asks the host to navigate. TWO spaces, selected by an EXPLICIT `scope`
// field on the payload, and that is the whole contract:
//
//   { scope: 'app',  path: 'detail/500' }  → APP-SCOPED, and the DEFAULT.
//        Resolved under the block's own route (`<base>/<slug>/detail/500`),
//        shallow, so the page stays mounted and the sub-path change reflects back
//        into the block through ROUTE_CHANGED. This is the pre-#5209 behaviour.
//   { scope: 'site', path: 'models/500' }  → SITE-ABSOLUTE. The host leaves the
//        app and lands on the site page, non-shallow. Unrestricted across page
//        routes — there is deliberately NO destination allowlist — except the one
//        narrow `/api/*` refusal, and only on a surface that HOLDS the capability
//        (`BLOCK_HOST_SITE_NAVIGATION`).
//
// 🔴 `scope` DEFAULTS TO `'app'`, AND THAT DEFAULT IS THE POINT, not a
// convenience. Every block deployed today sends no `scope` at all, so every one
// of them keeps exactly the behaviour it had before this change — for `'/x'` and
// for `'x'` alike. A host that cannot be rolled out without re-releasing the
// fleet is not a host change, it is a fleet migration.
//
// 🔴 A LEADING SLASH CARRIES NO MEANING. `scope` selects the space and `path` is
// a path WITHIN that space, so leading slashes are NORMALISED AWAY:
// `{scope:'app', path:'/settings'}` and `{scope:'app', path:'settings'}` are one
// request, as are `{scope:'site', path:'/models/500'}` and
// `{scope:'site', path:'models/500'}`. DO NOT reintroduce punctuation semantics
// here — see the retraction below for what it cost the first time.
//
// ⚠️ RETRACTED DESIGN, recorded so it is not re-derived: an earlier revision of
// this change keyed site-vs-app on the LEADING SLASH itself — `/models/500` was
// site, `models/500` was app. That is wrong for a reason specific to this
// platform, not merely inelegant. A page block owns a whole multi-page sub-path
// space (`/apps/run/[slug]/[[...path]].tsx`, the `subPath` in its init payload,
// the ROUTE_CHANGED forwarding above), so `navigate('/settings')` — the standard
// SPA idiom for an app's OWN absolute route — is a request every block author
// would write meaning "my settings page". Under the slash rule it silently left
// the app. And because BOTH spellings meant app-scoped before this change, that
// was a silent meaning change for every block ever written, delivered by a host
// deploy, with no version gate and no way for the block to notice: NAVIGATE is
// fire-and-forget, with no requestId and no NACK. Carrying intent in punctuation
// is exactly the prose/heuristic shape a deterministic field replaces.
//
// CONSEQUENCE, stated because it is the cost of the default and not a defect:
// the one real fleet caller of site-absolute navigation today
// (`civitai-app-custom-generators`, whose `onOpenInGenerator` calls
// `navigate('/generate')`) sends no `scope`, so it is app-scoped here and still
// does not reach the site generator. It did not reach it before this change
// either — so this is not a regression — but it does mean the host change ALONE
// no longer fixes that consumer. The app must opt in with `scope: 'site'`.
//
// WHY SITE SCOPE IS ALLOWED AT ALL, and why the width is an operator decision:
//   - The DEV host already behaves this way. `@civitai/blocks-react`'s `liveHost`
//     resolves the path against the backend origin and assigns it, with a comment
//     saying "so an in-app path (`/models/123`) opens on the real site".
//   - The published SDK JSDoc and the developer docs both promise it, and both use
//     `/models/12345` as the worked example.
//   So production was the odd one out among host, dev host and documentation.
//   This DOES widen what a block can do, deliberately. `ALLOWED_SANDBOX_TOKENS`
//   carries no `allow-top-navigation*`, so before this change a block could not
//   move the TOP frame at all — an `<a href>` it renders navigates its OWN frame,
//   at an opaque origin. Top-frame same-site navigation is a NEW capability,
//   granted on purpose and with the blast radius stated.
//   ⚠️ RETRACTED DRAFT, recorded so it is not re-derived: this comment used to
//   read "It does not widen what a block can persuade a viewer to visit." That
//   was false, and false in the direction that made the change look cheaper than
//   it is. The three-way agreement above establishes site-absolute REACHABILITY;
//   it does not establish that UNRESTRICTED is the right width — an allowlist
//   satisfies host, dev host and docs equally. The width is an operator decision
//   (see the PR), not something this argument derives.
//
// WHAT IS STILL REFUSED (fail-closed; a refusal returns `null` and the caller
// drops the message — NAVIGATE is fire-and-forget with no requestId, so a drop
// can never hang the block):
//   - any scheme (`https:`, `javascript:`, `data:`, …) and protocol-relative
//     `//host` — a block cannot push the host at another origin;
//   - backslashes, which several URL parsers fold to `/`;
//   - C0 controls, DEL and C1, which parsers strip wherever they appear (a
//     stripped byte changes which string the guard judged vs which one the browser
//     resolves). ⚠️ NOT a space, in ANY position — this line read "control
//     characters and whitespace" while a leading/trailing space was also refused,
//     and that rule is gone (see the retraction in `navigatePathIsHostile`);
//   - PERCENT-ENCODED path separators (`%2f`, `%5c`, either case) anywhere in the
//     block's own string — the only encodings that can change how many segments a
//     path has if anything downstream decodes once (see `navigatePathIsHostile`);
//   - any path whose RESOLVED form has a different SEGMENT STRUCTURE from the one
//     the block sent — which is what covers every traversal spelling, `.` and `..`
//     and `%2e` alike, without naming one (see the RESOLVED-FORM note below); plus
//     empty path segments (the `a//b` shape), which resolution does NOT collapse;
//   - an app-scoped path that leaves the block's own route — containment is
//     asserted on the resolved path;
//   - site scope on a surface that does not hold the capability;
//   - 🔴 `/api/*`, SITE SCOPE ONLY. A DELIBERATE NARROW EXCLUSION, and explicitly
//     NOT a destination allowlist. `/api/*` is not a page route, so a
//     `router.push` at it does not render anything — Next falls back to a HARD
//     navigation. The worked case is `/api/auth/logout`, and it is REAL: that
//     handler takes a bare GET with no `req.method` gate, no 405 and no CSRF
//     token, so it clears the session, device and legacy cookies and revokes the
//     token at the hub — on a block's say-so. `window.open` reaches it too, so
//     the refusal is load-bearing in BOTH targets.
//     ⚠️ An earlier draft named `/api/auth/signout`, which does NOT exist in this
//     repo: that is a next-auth name and auth here is `@civitai/auth`, whose
//     route is `logout.ts`. Do not "fix" this guard by checking the old example
//     and finding nothing there — the hole it covers is real.
//     Excluding `/api/*` costs the feature nothing (no page destination lives
//     there) and is the only content-based refusal here. An APP-scoped `api/...`
//     is untouched: it resolves under the block's own route and reaches no site
//     handler.
export type NavigateScope = 'site' | 'app';

export type NavigateRequest = {
  /** Which space the block asked for. `'app'` unless it explicitly said `'site'`. */
  scope: NavigateScope;
  /**
   * The host-router path to push, fully resolved. REBUILT from validated parts
   * rather than passed through, so a byte that survived the guards but not a
   * parser cannot reach the router.
   */
  href: string;
  /**
   * Shallow routing is correct ONLY for an app-scoped sub-path change — it keeps
   * the page mounted and skips the data fetch, which is the point there and
   * exactly wrong for a site destination (a shallow push at `/models/500` would
   * change the URL and render nothing, i.e. reproduce the #5209 symptom by a
   * second route).
   */
  shallow: boolean;
  /** Normalized target. Anything other than the literal `'new_tab'` is `'current'`. */
  target: 'current' | 'new_tab';
};

/** Rejected outright, before any scope decision. */
function navigatePathIsHostile(rawPath: string): boolean {
  // C0 controls, DEL and C1: URL parsers STRIP tab/LF/CR wherever they appear, so
  // the string a guard inspects would not be the string that resolves.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(rawPath)) return true;
  // ⚠️ A LEADING OR TRAILING SPACE WAS REFUSED HERE AND THE RULE IS NOW GONE. The
  // retraction is recorded AT THE LINE so the wrong explanation is not re-derived.
  //
  // What the rule claimed: that it was not subsumed by the structural rule below,
  // because `' /models/1'` "resolves to `/models/1` with the segment count
  // PRESERVED, so the count comparison cannot see the trimmed byte". The
  // CONCLUSION was right — the structural rule genuinely cannot see it — but the
  // MECHANISM was false for the leading position, and that is the half the worked
  // example named. The candidate is REBUILT as `/${path}` before resolution, so a
  // leading space is never at a string END for WHATWG to trim: measured,
  // `new URL('/ x', <sentinel>).pathname` is `/%20x`, and `' /models/1'` resolves
  // to `/%20/models/1`, NOT to `/models/1`. It is percent-encoded exactly like the
  // INTERIOR space this change deliberately re-admitted. So the leading half had
  // no mechanism at all: nothing is trimmed, therefore nothing is hidden from any
  // guard.
  //
  // The TRAILING half's mechanism IS real — `new URL('/x ', <sentinel>).pathname`
  // is `/x`, at an unchanged count of 2 → 2 — and it still closed nothing, because
  // every decision downstream reads the RESOLVED path, which is this function's
  // whole design: the `/api` first-segment check, app containment, and the
  // returned `href` itself. Measured with the rule removed,
  // `{ scope: 'site', path: 'api/auth/logout ' }` is STILL refused, by the `/api`
  // check reading the resolved first segment.
  //
  // So it was fail-closed POSTURE, not a hazard closure, and it cost
  // `navigate(' x')` and `navigate('x ')`, both of which WORKED at the merge base.
  // That is the same class the structural rule was relaxed to re-admit, and the
  // same class the interior-space refusal above was removed for: an app sub-path
  // in the block author's own namespace, dropped silently, undetectable by the
  // block. Dropped for consistency with that decision rather than kept as a third
  // spelling of it.
  //
  // MEASURED BEFORE DROPPING, over a 26-shape space corpus in BOTH scopes:
  // 0 containment escapes, 0 `/api` leaks, 0 off-origin (3/26 accepted with the
  // rule; 13/26 site and 15/26 app without it). Every href the wider set accepts
  // is a re-resolution FIXPOINT — 21 of 21, against a positive control (`/a/../b`)
  // that is not — so no consumer can re-derive a different path from one. And
  // whitespace-ONLY paths stay refused without this rule: `' '` and `'/ '` resolve
  // to `/`, which the structural rule sees as 2 → 1.
  //
  // 🔴 THE INTERIOR CASE USED TO BE REFUSED HERE TOO, by a class that ran to
  // `U+0020` INCLUSIVE, and that was a SECOND refusal channel for exactly the class
  // the structural rule below was relaxed to admit. Fixing only the structural rule
  // would have left `navigate('a b')` — which WORKED at the merge base, no
  // resolver having existed then — silently dropped, with the fix looking
  // applied and a green suite. Both channels had to move; this paragraph is why
  // U+0020 is excluded from the control-character class on the line above.

  // Protocol-relative (`//host`, and `/\host` which Chrome folds to it). Note
  // this runs on the RAW string, BEFORE leading slashes are normalised away, so
  // `//evil.example` is refused rather than read as a redundantly-slashed path.
  if (/^\/[/\\]/.test(rawPath)) return true;
  // Any scheme at all — `https:`, `javascript:`, `data:`, `mailto:`.
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(rawPath)) return true;
  // A backslash ANYWHERE, including in the query or fragment — folded to `/` by
  // several parsers.
  //
  // ⚠️ SCOPE NOTE, measured: in the PATH portion this line is now redundant.
  // `new URL` folds `\` to `/` for a special scheme, so `models\500` resolves
  // with a DIFFERENT segment count and the structural rule below refuses it
  // anyway. What this line uniquely still refuses is a backslash in QUERY or
  // FRAGMENT position (`/search?q=a\b`), which the structural rule cannot see
  // because the path portion ends at the first `?`. That is kept deliberately
  // rather than narrowed to the path: the resolved `href` is handed to consumers
  // beyond `new URL` (Next's router, `window.open`, and anything that later logs
  // or re-parses it), and a parser that folds `\` to `/` in a query is the case
  // this closes. The cost is a query shape no caller has been observed to use.
  // Pinned by its own test so it is not zero-coverage decoration.
  if (rawPath.includes('\\')) return true;
  // 🔴 PERCENT-ENCODED PATH SEPARATORS. `new URL` does NOT decode these — measured,
  // `/api%2fauth%2flogout` resolves to itself and `/a%2fb` stays `/a%2fb` — so they
  // survive resolution as ONE segment, and the resolved-form guards below then judge
  // a segment named `api%2fauth%2flogout` rather than one named `api`. They become a
  // separator only if something downstream decodes once, and the whole point of
  // judging the resolved form is to stop depending on what downstream does. `%2f`
  // and `%5c` are the complete set of separator-producing single decodes (`/` and
  // the `\` that parsers fold to `/`), so refusing them closes the family rather
  // than one spelling of it, and after this no remaining `%` in the block's string
  // can change segment COUNT — which is the property the `/api` and containment
  // checks below rest on. Cost: a page route with a literal `/` inside one segment
  // becomes unreachable. Next's page router cannot express such a route, so the cost
  // is zero here; and this is scoped to the BLOCK's string, not the host-built app
  // base, which legitimately carries `%2F` from `encodeURIComponent(slug)`.
  if (/%(?:2f|5c)/i.test(rawPath)) return true;
  return false;
}

/**
 * The origin every candidate path is resolved against. `.invalid` is reserved by
 * RFC 2606 and can never resolve, so a candidate that smuggles its own origin
 * shows up as an origin MISMATCH below rather than being silently adopted.
 */
const NAVIGATE_SENTINEL_ORIGIN = 'https://page-block-host.invalid';

/**
 * Segment count of a path portion, with ONE trailing empty segment dropped.
 *
 * 🔴 THE DROP IS LOAD-BEARING AND WAS FOUND BY MEASUREMENT, NOT BY READING THE
 * SPEC. When WHATWG removes a dot segment that is LAST, it appends an empty
 * string to the path — so `/a/.` resolves to `/a/`, `/..` and `/.` both resolve
 * to `/`, and a naive `split('/').length` comparison is PRESERVED across those
 * three, i.e. it would let a trailing dot segment through. Dropping one trailing
 * empty on both sides cancels that compensation exactly, and leaves the trailing
 * slash the contract does tolerate (`/generate/` counts as `/generate`) intact.
 *
 * Measured over a generated corpus of 1,020 dot-segment shapes (every spelling in
 * {`.`, `..`, `%2e`, `%2E`, `%2e%2e`, `%2E%2E`, `.%2e`, `%2e.`, `%2E.`, `.%2E`} at
 * every position in paths of length 1–4, in pairs, and walking out of an app base,
 * each with and without a trailing slash): 1,020 of 1,020 refused, every one of
 * them by THIS comparison. Against a 28-case normalisation corpus (non-ASCII,
 * spaces, the URL path percent-encode set, double-encoding, `..b`/`b..`/`...`,
 * `%61pi`, a trailing slash, `/`): 0 refused.
 */
function navigateSegmentCount(pathPortion: string): number {
  const parts = pathPortion.split('/');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/**
 * 🔴 JUDGE THE RESOLVED STRING, NOT THE SPELLING SENT — and return the resolved
 * string, so what was validated and what gets pushed are the same bytes.
 *
 * THE HAZARD THIS CLOSES. The first version of this resolver split the raw path
 * on `/` and refused a segment that literally equalled `.` or `..`, then refused a
 * first segment that literally equalled `api`. Both were SPELLED guards, and the
 * hazard existed in a different spelling: WHATWG URL counts `%2e` as a dot
 * segment, so `{ path: '/%2e%2e/api/auth/logout' }` had no segment equal to `..`
 * and a first segment of `%2e%2e` rather than `api`, and passed — while BOTH
 * consumers resolved it straight to the refused route. Measured in node, all six
 * of these resolve to `/api/auth/logout`:
 *
 *   /%2e%2e/api/auth/logout        /%2E%2E/api/auth/logout
 *   /%2e/api/auth/logout           /.%2e/api/auth/logout
 *   /%2e./api/auth/logout          /models/%2e%2e/api/auth/logout
 *
 * `target: 'new_tab'` reaches the handler through `window.open` with no Next
 * involved; `target: 'current'` reaches it because Next's `parseRelativeUrl` is
 * `new URL`-based and hands the router the NORMALISED pathname, which then misses
 * the route manifest and hard-navigates. Neither needs a user gesture. The same
 * root cause broke app-scope containment — measured,
 * `/apps/run/<slug>/%2e%2e/%2e%2e/%2e%2e/x` resolved to `/x`.
 *
 * 🔴 THE TEST IS STRUCTURAL, AND IT USED TO BE BYTE-EQUALITY. THAT WAS A
 * REGRESSION AGAINST `origin/main` AND IS THE SECOND THING THIS FUNCTION FIXES.
 * The first fix asked "is the resolved pathname ALREADY the string handed in?" —
 * a normalisation FIXPOINT. That closed the hole, but it refuses everything
 * resolution rewrites, which is every non-ASCII codepoint and every member of the
 * URL path percent-encode set (space, `"`, `<`, `>`, `^`, `` ` ``, `{`, `}`). Two
 * reachable costs, one of them a genuine regression:
 *   - `/tag/<tagname>` is a live route (`src/pages/tag/[tagname].tsx`) and this
 *     codebase already percent-encodes tag names when it builds that URL itself
 *     — 5 sites across 3 files, derived rather than quoted:
 *     `find src -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 | xargs -0
 *     grep -n 'tag/${encodeURIComponent'`. (⚠ an earlier draft said "three
 *     places"; that was an undercount from a narrower search.) So the codebase
 *     already concedes tag names are not ASCII-safe, and a block could not link
 *     one.
 *   - 🔴 APP-SCOPED SUB-PATHS. At the merge base there was no resolver at all:
 *     leading slashes were stripped and only `//`, a literal `..` segment and a
 *     re-leading `/` were refused. So `navigate('José')`, `navigate('café')` and
 *     `navigate('a b')` each pushed `/apps/run/<slug>/<raw>` and WORKED. The
 *     fixpoint rule dropped all three silently. App sub-paths are entirely the
 *     block author's own namespace, so that is the member most likely to exist in
 *     the wild, and a block cannot detect the drop.
 *
 * So the rule is now: the resolved path must have the SAME SEGMENT STRUCTURE as
 * the candidate. Every traversal shape changes the segment count (`/%2e%2e/api/x`
 * is 3 → 2); pure percent-encoding normalisation preserves it (`/tag/José` is
 * 3 → 3, rewritten but not restructured). That keeps the guard structural — no
 * dot spelling is named anywhere in it — while allowing the international and
 * space-bearing paths the byte comparison refused. See `navigateSegmentCount` for
 * the trailing-dot-segment correction the naive count needs, and the corpus it
 * was measured over.
 *
 * Encoding shapes considered and decided, so none of this is re-derived:
 *   - `%2e` / `%2E`, and the mixed `.%2e` / `%2e.` forms: closed by the segment
 *     count. Case never enters into it, because nothing pattern-matches a
 *     spelling — the counts of two strings are compared.
 *   - `%2f` / `%5c` (encoded separators): refused upstream in
 *     `navigatePathIsHostile`, with the reasoning there.
 *   - `%252e` (double-encoded): ALLOWED, and this is a decision, not an oversight.
 *     Reaching a dot segment from it needs TWO decodes; `new URL` does zero, so
 *     `/%252e%252e/api/x` keeps 5 segments and its first segment is the literal
 *     string `%252e%252e`. A single downstream decode yields `%2e%2e`, still a
 *     literal segment — dot-segment resolution happens in the URL parser BEFORE
 *     the request is sent, not after a server decodes it, so there is no second
 *     resolution pass for the decoded form to be fed into. Refusing `%25`
 *     outright was considered and rejected: `/models/500/50%25-off-lora` is a
 *     legitimate civitai slug route, so that would be a real false refusal.
 *   - a trailing slash: tolerated exactly as before (one, and only at the end).
 *     `/api/` still refuses because the segment check runs on the stripped path;
 *     `/apps/run/<slug>/` still satisfies containment because it strips to the
 *     base itself. The strip happens after the structural check, and the stripped
 *     result is itself structurally stable, which is pinned by an idempotency test.
 *   - a surviving `%` that changes SEGMENTATION: impossible once `%2f`/`%5c` are
 *     refused, because those are the only single decodes that produce a
 *     separator. A surviving `%` can still change a segment's VALUE (`%61pi`
 *     decodes to `api`), which is why the `/api` check below decodes before
 *     comparing.
 *   - a character resolution REWRITES rather than preserves (`/a<b` becomes
 *     `/a%3Cb`, `/tag/José` becomes `/tag/Jos%C3%A9`): now ALLOWED, and the
 *     returned href is the RESOLVED form, so what was judged is what is pushed.
 *     That is the regression fix above.
 */
function resolveNavigatePath(candidate: string): { path: string; suffix: string } | null {
  let url: URL;
  try {
    url = new URL(candidate, NAVIGATE_SENTINEL_ORIGIN);
  } catch {
    // 🔴 UNREACHABLE FOR EVERY SHIPPED BASE (guard 1 of the list in this module's
    // NAVIGATE tests — see the precondition at the end of this block), and
    // labelled rather than counted as coverage. A relative reference resolved
    // against a valid absolute base does not throw. MEASURED THROUGH THIS
    // FUNCTION'S OWN PUBLIC ENTRY POINT, so the hostile filter is applied exactly
    // as production applies it: every Unicode scalar value (0x0..0x10FFFF minus
    // surrogates) in 7 positions × both scope spellings — 15,568,896 candidates,
    // 0 throws. With two controls, because a zero alone is indistinguishable from
    // a sweep wired to nothing: 15,567,940 of those candidates were ACCEPTED (so
    // the sweep is not merely refusing everything), and the harness was shown able
    // to count a throw at all against an input `new URL` really does reject. A
    // mutant that ADOPTS an unresolvable candidate instead of refusing it also
    // left the suite green.
    // ⚠ An earlier draft of this line said 15,567,954, a figure carried over from
    // the review rather than re-derived; the number above is this tree's own. Kept as a structural backstop because `new URL` is a platform API
    // whose throw conditions are not ours to fix, and refusing is the only
    // fail-closed answer for a string whose resolved form we cannot know.
    //
    // 🔴 THE PRECONDITION THAT MAKES THIS LABEL AND GUARD 2'S TRUE, AND NOTHING
    // VALIDATES IT: every value in `BLOCK_HOST_DEEP_LINK_BASE` is a path rooted at
    // exactly ONE `/` and is not `/` itself. App scope builds the candidate as
    // `${base}/${encodeURIComponent(slug)}/${path}`, so a base of `/` would make
    // it `//<slug>/…` — PROTOCOL-RELATIVE, which `navigatePathIsHostile` never
    // sees because that filter runs on the BLOCK's string, not on the host-built
    // candidate. Measured with a hypothetical `base: '/'` over the same sweep as
    // above (15,568,896 candidates): guard 2 fires 7,783,978 times — every
    // app-scoped candidate that reaches it — guard 1 fires 0, and there are 0
    // containment escapes, 0 `/api` leaks and 0 off-origin hrefs. So these two
    // lines are NOT decoration under that base; they are the entire defence, which
    // is the case FOR keeping them and is why the labels now say "for every
    // SHIPPED base" rather than "unreachable". A base is a hand-written constant
    // today; if one is ever derived, these labels expire before the code does.
    // ⚠ The audit that raised this reported guards 1 and 2 firing 8,446 times EACH.
    // Not reproduced here: with a fixed valid slug the authority is always the
    // slug, so `new URL` cannot throw and guard 1 cannot fire. Recorded as
    // unexplained rather than restated.
    return null;
  }
  // 🔴 UNREACHABLE FOR EVERY SHIPPED BASE (guard 2), measured the same way:
  // forcing this condition to `false` leaves the suite green, because
  // `navigatePathIsHostile` refuses every scheme and every `//host` shape before we
  // get here, and with those gone a relative input resolved against an absolute
  // base cannot produce another origin. Kept because it states the property
  // structurally, so loosening a pattern check cannot silently take the property
  // with it. NOT coverage.
  //
  // 🔴 SAME PRECONDITION AS GUARD 1, and it binds this line HARDER: under a
  // hypothetical `base: '/'` the host-built candidate is protocol-relative and
  // THIS line is what refuses it — 7,783,978 times over the sweep, with 0 escapes.
  // `navigatePathIsHostile` cannot help there, because it inspects the block's
  // string and the `//` comes from the host's own base. Read the precondition
  // paragraph in the `catch` above before calling this line decoration.
  if (url.origin !== NAVIGATE_SENTINEL_ORIGIN) return null;

  // The path portion of the candidate ends at the first `?` or `#` — per the URL
  // spec, no escape can move that boundary.
  const cut = candidate.search(/[?#]/);
  const candidatePath = cut === -1 ? candidate : candidate.slice(0, cut);
  // THE STRUCTURAL RULE. Resolution may rewrite a segment's bytes; it may not
  // change how many segments there are.
  if (navigateSegmentCount(candidatePath) !== navigateSegmentCount(url.pathname)) return null;

  // One trailing slash is tolerated (`/generate/` is a plausible authoring shape,
  // and silently dropping the navigation is the "the feature looks dead" failure
  // this change exists to end). Every OTHER empty segment is a rejection.
  const path =
    url.pathname.length > 1 && url.pathname.endsWith('/')
      ? url.pathname.slice(0, -1)
      : url.pathname;
  const segments = path === '/' ? [] : path.slice(1).split('/');
  for (const s of segments) {
    // REACHABLE and tested: `/a//b` is structurally stable (resolution does not
    // collapse empty segments), so the count rule cannot see it and this does.
    if (s === '') return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(s);
    } catch {
      // A malformed escape cannot BE a dot segment, so it is not this clause's
      // business. Deliberately NOT a refusal — `/x/50%-off` is a legitimate
      // segment shape, and refusing it here would widen the refusal set for
      // nothing. (Site scope's FIRST segment is a separate, deliberate
      // exception — see `navigateSiteFirstSegmentIsRefused`.)
      continue;
    }
    // 🔴 UNREACHABLE (guard 3). A resolved path never CONTAINS a dot segment:
    // WHATWG removes `.`, `..` and every percent spelling of them during
    // resolution, and a segment that merely contains dots (`..b`, `a%2e`) does not
    // decode to `.` or `..`. Measured over the 1,020-shape dot corpus — the count
    // rule above refused all 1,020 and this clause fired 0 times. Kept as a
    // structural backstop in case a future URL-spec revision leaves a dot
    // spelling in place, which is precisely the case the count rule would then
    // also miss. NOT coverage.
    if (decoded === '.' || decoded === '..') return null;
  }

  return { path, suffix: url.search + url.hash };
}

/**
 * Site-scope refusal on a resolved path's FIRST segment. Operates on the resolved
 * path, so no dot-segment spelling can hide the segment from it, and decodes that
 * segment before comparing so no percent-encoding can hide the WORD
 * (`/%61pi/auth/logout` is structurally stable and its first segment decodes to
 * `api`).
 *
 * ⚠️ THE NAME SAYS "REFUSED", NOT "IS API", BECAUSE THERE ARE TWO CHANNELS AND
 * THE SECOND ONE IS NOT THE `/api` RULE. A malformed escape in the first segment
 * (`/%/x`, `/%zz/x`) cannot be decoded, so its meaning cannot be established and
 * it is refused too. That is a deliberate fail-closed decision, but calling the
 * function `…IsApi` made it a refusal channel wearing a predicate's name: it
 * returned `true` for a segment that is not `api` at all. The asymmetry it
 * creates is real and is kept rather than hidden — `/50%-off/x` is refused while
 * `/x/50%-off` is allowed, because only the FIRST segment decides the `/api`
 * question and only this call site needs a verdict on it.
 *
 * The decode is safe to reason about only because `%2f`/`%5c` are already refused:
 * with those gone, decoding a segment cannot introduce a separator, so it cannot
 * turn one segment into two and cannot move which segment is first.
 */
function navigateSiteFirstSegmentIsRefused(path: string): boolean {
  const first = path === '/' ? '' : path.slice(1).split('/')[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(first);
  } catch {
    // Channel 2: a segment whose meaning cannot be established is not pushed.
    return true;
  }
  // ONE comparison, deliberately. A `first.toLowerCase() === 'api'` fast path was
  // written here first and then deleted: `decodeURIComponent('api')` is `'api'`, so
  // it could never reach a verdict this line does not, and a mutation run confirmed
  // it SURVIVED every test — i.e. it was a line that read as a guard while guarding
  // nothing. Two spellings of one rule is two places for it to drift.
  return decoded.toLowerCase() === 'api';
}

/**
 * Validate a raw NAVIGATE payload from an untrusted iframe and resolve it to the
 * host-router push the caller should perform, or `null` when the message must be
 * DROPPED. Pure — the caller owns `router.push` and the `reviewMode` / gate-status
 * refusals, which are conditions on the HOST, not on the payload.
 *
 * 🔴 THE TWO SURFACE INPUTS ARE INDEPENDENT, AND THAT SEPARATION IS THE DESIGN.
 * `base` is the surface's APP deep-link root (`BLOCK_HOST_DEEP_LINK_BASE`); a
 * `null` base means the surface has no in-app route to push into, so app-scoped
 * navigation is dropped. `siteNavigation` is a SEPARATE per-surface capability
 * (`BLOCK_HOST_SITE_NAVIGATION`): may this surface let a block move the viewer
 * OFF the app? One concern each, one authority each — a surface that should do
 * neither says so twice, explicitly, rather than having one `null` stand in for
 * two different decisions. Both are total `Record`s over `BlockHostSurface`, so a
 * new surface is a compile error in both until someone decides both.
 */
export function resolveNavigateRequest(
  raw: unknown,
  opts: { base: string | null; slug: string; siteNavigation: boolean }
): NavigateRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const rawPath = obj.path;
  if (typeof rawPath !== 'string') return null;
  if (navigatePathIsHostile(rawPath)) return null;

  const target: 'current' | 'new_tab' = obj.target === 'new_tab' ? 'new_tab' : 'current';
  // 🔴 ABSENT OR UNKNOWN `scope` IS `'app'`. This is the back-compat property: a
  // block deployed before `scope` existed sends nothing and keeps its old
  // behaviour. Compared with the literal `'site'` rather than validated against
  // the union, so an unknown future value fails CLOSED onto the narrower space.
  const scope: NavigateScope = obj.scope === 'site' ? 'site' : 'app';
  // Leading slashes are normalised away — `scope` already said which space this
  // is, so the slash has nothing left to mean. `//x` never reaches here (refused
  // as protocol-relative above), so at most one slash is ever stripped; the `+` is
  // belt-and-braces rather than a second rule.
  const path = rawPath.replace(/^\/+/, '');

  if (scope === 'site') {
    // 🔴 PER-SURFACE CAPABILITY. `private-run` holds a base (its own app route) but
    // NOT this capability: that route resolves an audience including `moderator`,
    // serves `suspended` and delisted apps, and passes no `reviewMode` — so
    // without this refusal a suspended app could move a moderator's tab to any
    // page route on the site. App-scoped deep-linking inside the author's own
    // preview is harmless and is what that surface exists for, which is why this
    // is a capability and not another `null` base.
    if (!opts.siteNavigation) return null;
    const resolved = resolveNavigatePath(`/${path}`);
    if (resolved === null) return null;
    // The one content-based refusal. See the `/api/*` note above.
    if (navigateSiteFirstSegmentIsRefused(resolved.path)) return null;
    return { scope, href: `${resolved.path}${resolved.suffix}`, shallow: false, target };
  }

  // A surface with no app deep-link base has nowhere to push an app-scoped path.
  //
  // 🔴 UNREACHABLE (guard 5), and this one was FOUND BY THE MUTATION BATTERY
  // for this change rather than reasoned about: removing the line leaves the suite
  // green. The reason is an ACCIDENT and must not be relied on — `String(null)`
  // is `'null'`, so a null base builds the candidate `null/<slug>/<path>`, a
  // RELATIVE reference whose resolution prepends `/` and therefore adds a segment,
  // which the structural rule refuses. Every real base starts with `/`.
  //
  // It is kept BECAUSE that is an accident. A surface's "I have no in-app route"
  // decision must not rest on how JavaScript stringifies `null`, and a future base
  // value that happened to start with `/` would silently grant app navigation to a
  // surface that declared none. NOT coverage.
  //
  // ⚠ It was REACHABLE at the PR head, where this check sat BEFORE the scope
  // branch and refused site scope too. Separating the two surface inputs moved the
  // site half onto `siteNavigation` (reachable — its own mutants are killed) and
  // left this half behind the structural rule.
  if (opts.base == null) return null;
  // App scope: resolve the candidate the consumers will actually resolve — base
  // and block path TOGETHER — because the containment property is about the whole
  // string, not about the block's half of it. Appending `/` unconditionally is
  // correct: an empty `path` yields `<base>/`, which the trailing-slash rule
  // strips back to the base, matching the pre-existing app-root behaviour.
  const appBase = `${opts.base}/${encodeURIComponent(opts.slug)}`;
  const resolved = resolveNavigatePath(`${appBase}/${path}`);
  if (resolved === null) return null;
  // CONTAINMENT, ASSERTED ON THE RESOLVED PATH — a BACKSTOP that pins the property,
  // and 🔴 UNREACHABLE (guard 4). Say so plainly, because a line that reads as the
  // defence while never executing is worse than no line: it stops the next reader
  // looking for the real one.
  //
  // MEASURED: forcing this condition to `false` leaves the suite GREEN, and a sweep
  // of 200 app-scope block paths built from every dot spelling produced 0 escapes
  // with this line removed. What actually closes the app-scope escape is the
  // STRUCTURAL RULE inside `resolveNavigatePath` — `%2e%2e/x` builds the candidate
  // `<appBase>/%2e%2e/x`, whose resolved form has fewer segments, and is refused
  // there before this line runs. And that is not an accident of the fixtures: the
  // candidate is built as the literal `${appBase}/${path}`, resolution never ADDS a
  // segment, and `${appBase}` is itself structurally stable (host-chosen base plus
  // `encodeURIComponent(slug)`), so IF the segment count survived then segment i of
  // the resolved path still corresponds to segment i of the candidate and the base
  // prefix is intact. Containment is therefore a THEOREM of the structural rule
  // here, not an independent check.
  //
  // It is kept anyway, deliberately: the theorem has premises, and a future change
  // that relaxes the structural rule would silently take the property with it. This
  // line makes the property fail loudly instead. Do NOT count it as coverage, and
  // do not delete the structural rule on the strength of it.
  //
  // The explicit `/` is what stops a sibling route whose name merely starts with
  // the base from passing a bare `startsWith`; that refinement is unreachable for
  // the same reason (its own mutant also survives).
  if (resolved.path !== appBase && !resolved.path.startsWith(`${appBase}/`)) return null;
  return { scope, href: `${resolved.path}${resolved.suffix}`, shallow: true, target };
}

export type PageFallbackReason = 'timeout' | 'token_error' | 'fatal_block_error';

/**
 * #4: map a PageBlockHost terminal status to a BlockFallback reason. Unlike the
 * model IframeHost (which collapses to null on failure because a model column
 * can disappear cleanly), a FULL-PAGE surface that collapses is just a blank
 * viewport. So a failed page renders a message INSIDE the trust frame instead.
 * Returns null for the non-terminal (loading / ready) states — those render the
 * iframe, not a fallback.
 *
 * Anti-spoof note: the message is HOST chrome (not the block), so a failed
 * block still can't masquerade as a working page.
 */
export function pageFallbackReason(status: PageHostStatus): PageFallbackReason | null {
  switch (status) {
    case 'loading':
    case 'ready':
      return null;
    case 'fatal':
      return 'fatal_block_error';
    case 'error':
    case 'no_token':
      return 'token_error';
    case 'timeout':
      return 'timeout';
  }
}

// ── BOUNDED AUTO-RETRY (launch-failure recovery) ─────────────────────────────
//
// The reported defect was NOT that the retry LOGIC was broken — it works — but
// that a transient launch failure required the user to notice and press a
// button, and the button was easy to miss ("there might have been a retry
// button but I didn't notice — I did a full page reload"). So the host now
// re-attempts the load ITSELF a bounded number of times, and only after that
// budget is spent does it settle on a definitive terminal state whose manual
// Retry is made prominent.
//
// 🔴 THE TERMINAL STATE IS NEVER DELAYED OR MASKED. The host renders the real
// terminal `BlockFallback` the instant a terminal status is reached; the pending
// auto-retry is surfaced as ADDITIONAL copy inside that same fallback. There is
// no "keep spinning while we quietly retry" state — that would recreate the
// silent-blank failure class this codebase has fought repeatedly.
//
// 🔴 BOUNDED, ALWAYS. Two independent caps:
//   - MAX_AUTO_RETRIES bounds the total automatic attempts per host mount.
//   - MAX_AUTO_REMINTS bounds how many of those may spend a token RE-MINT.
//     `/api/v1/block-tokens` is rate-limited (60/min per user+instance), and an
//     unbounded auth-failure loop is exactly the shape that would burn it.
// The budgets are per MOUNT and are NOT refilled by a manual Retry — once spent,
// every subsequent failure goes straight to the definitive terminal state.

/**
 * Maximum AUTOMATIC load re-attempts per host mount (the initial load excluded).
 *
 * 🔴 ROLLBACK: setting this to 0 cleanly disables auto-retry entirely — the
 * decision returns `none` for every status, so the terminal fallback renders
 * immediately with the prominent manual Retry and `autoRetriesSpent` stays 0 (no
 * false "we already retried" copy). It is the one-line kill switch; there is no
 * feature flag on this path.
 */
export const MAX_AUTO_RETRIES = 2;

/**
 * Maximum automatic attempts that may spend a token RE-MINT. Auth terminals
 * (`error`/`no_token`) can only be recovered by re-minting — a local remount can
 * never clear them — so this is the specific cap that protects the rate-limited
 * `/api/v1/block-tokens` (60/min per user+instance) from an automatic loop.
 *
 * 🔴 MUST STAY STRICTLY BELOW `MAX_AUTO_RETRIES`, and there is a test that pins
 * exactly that. Because `reminted` is a SUBSET of `attempts` (every re-minting
 * attempt also increments `attempts`), the invariant `reminted <= attempts` holds
 * — so if the two caps were EQUAL the total-attempt check, which runs first,
 * would always fire first and this cap would be unreachable dead code: a stated
 * safety limit that provably cannot bind. Keeping it strictly lower makes it the
 * binding constraint on the auth path (the expensive one), while non-auth
 * terminals — which cost nothing but a remount — still get the full budget.
 */
export const MAX_AUTO_REMINTS = 1;

/**
 * Backoff before automatic attempt N (index 0 = the first auto-retry). Modest and
 * exponential-ish: long enough for a transient blip/deploy-drain to clear, short
 * enough that a real failure settles quickly. Indices past the end reuse the last
 * value (defensive — today the array covers MAX_AUTO_RETRIES exactly).
 */
export const AUTO_RETRY_BACKOFF_MS: readonly number[] = [2_000, 5_000];

/**
 * How long the host waits for the block to ack `BLOCK_READY` before settling on
 * the `timeout` terminal, and how long it waits for a token before settling on
 * `no_token`. Re-exported from `PageBlockHost` (its historical home) so existing
 * importers are unaffected.
 *
 * 🔴 They live HERE, in the pure module, so a NODE test can import them: they are
 * inputs to `worstReachableLaunchMs()` below, and importing them from the
 * component would drag the whole React graph into the `unit` project.
 */
export const BLOCK_READY_TIMEOUT_MS = 10_000;
export const TOKEN_WAIT_TIMEOUT_MS = 15_000;

/**
 * The longest wall-clock a SUCCESSFUL launch can legitimately take, derived from
 * the constants above rather than asserted.
 *
 * 🔴 WHY THIS IS A FUNCTION AND NOT A COMMENT. The launch-latency histograms drop
 * any sample past a fixed cap, and that cap has to clear this bound or it silently
 * discards real slow successes — a slowness-correlated drop that trims exactly the
 * tail the metric exists to show. Two earlier revisions got the arithmetic wrong in
 * a comment (once by ~27s, once by ~10s) and nothing was red either time. A test
 * now asserts both caps exceed this value, so widening any input below walks the
 * bound up and fails loudly.
 *
 * 🔴 THE SEQUENCE, and why it is NOT `attempts x (token + ready)`:
 *
 *   attempt 1   no token at all -> `no_token` at TOKEN_WAIT_TIMEOUT_MS.
 *               This is an AUTH terminal, so it spends the re-mint budget.
 *   + backoff[0]
 *   attempt 2   a re-mint is in flight, so this attempt can AGAIN pay the full
 *               token wait; the ready timer only arms once `hasToken` lets
 *               `shouldStartInit` pass, so the two windows are SERIAL within the
 *               attempt: TOKEN_WAIT + BLOCK_READY_TIMEOUT -> `timeout`.
 *               `timeout` is NON-auth, so it spends no re-mint and a third
 *               attempt is still allowed.
 *   + backoff[1]
 *   attempt 3   the token from attempt 2 PERSISTS (nothing cleared it), so the
 *               token wait cannot be paid again — this attempt is bounded by
 *               BLOCK_READY_TIMEOUT alone, and ends in `ok`.
 *
 * Two consecutive `no_token`s are UNREACHABLE (`MAX_AUTO_REMINTS = 1` stops the
 * second), and a post-`timeout` attempt cannot re-pay the token wait. Both of
 * those are why the naive `3 x (15 + 10) + backoffs` = 82s over-states it, and
 * why treating every attempt as ~15s under-states it.
 */
export function worstReachableLaunchMs(): number {
  const backoffs = AUTO_RETRY_BACKOFF_MS.slice(0, MAX_AUTO_RETRIES).reduce((a, b) => a + b, 0);
  // attempt 1: the auth terminal that costs the full token wait.
  const first = TOKEN_WAIT_TIMEOUT_MS;
  // The one attempt that can pay BOTH windows (a re-mint is in flight).
  const remintedAttempt = TOKEN_WAIT_TIMEOUT_MS + BLOCK_READY_TIMEOUT_MS;
  // Every later attempt already holds a token, so it is ready-bounded only.
  const tokenHoldingAttempts = Math.max(0, MAX_AUTO_RETRIES - MAX_AUTO_REMINTS);
  return first + remintedAttempt + tokenHoldingAttempts * BLOCK_READY_TIMEOUT_MS + backoffs;
}

/**
 * The most BLOCK_INIT posts one successful launch can make **via the bounded
 * AUTOMATIC retry path**.
 *
 * 🔴 THAT QUALIFIER IS LOAD-BEARING — this is NOT an absolute maximum, and an
 * earlier revision of this docstring wrongly claimed it was. A MANUAL retry is
 * deliberately uncapped (`handleRetry` spends no automatic budget), and
 * `performRetry` resets neither the launch marks nor `blockRenderEmittedRef`.
 * So a user who clicks Retry repeatedly *inside the auto-retry backoff window*
 * keeps `autoRetryBudget.attempts` at 0, emits no beacon yet, and accumulates
 * posts across unboundedly many attempts into ONE launch sample.
 *
 * The consequence is bounded and lands in the safe direction: past
 * `MAX_LAUNCH_INIT_POSTS` the count is DROPPED, never clamped, so no wrong value
 * is ever published. What it does cost is a launch counted in
 * `launch_total_seconds` but absent from `launch_init_posts` — which is exactly
 * why the histogram's help text insists on its OWN `_count` as the denominator.
 *
 * 🔴 THE POST-COUNT SIBLING OF `worstReachableLaunchMs`, and it exists for the
 * identical reason: `boundedInitPosts` DROPS anything past `MAX_LAUNCH_INIT_POSTS`,
 * so a cap below this bound would silently discard the launches that posted the
 * most — i.e. precisely the quantization-bound ones the field was added to find.
 * The discard would be signal-correlated and would make the metric answer "no
 * quantization here" by construction.
 *
 * 🔴 THE COUNT IS PER LAUNCH, NOT PER CONTROLLER. The auto-retry path builds a
 * fresh `IframeInitController` per attempt but does NOT reset the launch marks,
 * so the posts accumulate across every attempt of one launch. The bound is
 * therefore `attempts x per-attempt-max`, plus one `BLOCK_HELLO` push per
 * attempt (`notifyHello` is honored at most once per controller).
 *
 * Each attempt's controller is bounded by its own readiness timeout: it stops
 * at `BLOCK_READY_TIMEOUT_MS`, whatever else the attempt spent waiting on a
 * token. So `TOKEN_WAIT_TIMEOUT_MS` deliberately does NOT appear here — that is
 * the one place this bound's shape differs from `worstReachableLaunchMs`'s.
 */
export function worstReachableInitPosts(): number {
  const attempts = MAX_AUTO_RETRIES + 1;
  const perAttempt = maxInitPostsWithin(BLOCK_READY_TIMEOUT_MS) + 1; // +1 = the BLOCK_HELLO push
  return attempts * perAttempt;
}

/** Terminal statuses a bounded auto-retry may attempt to recover from. */
export function isAutoRetryableStatus(status: PageHostStatus): boolean {
  return status === 'timeout' || status === 'fatal' || status === 'no_token' || status === 'error';
}

/**
 * AUTH terminals: the iframe never received a usable token. `token`/`tokenError`
 * are PROPS owned upstream (useBlockToken in the route), and `shouldStartInit`
 * gates on `hasToken` — so a local remount alone can NEVER recover these; only a
 * re-mint can. Mirrors the manual-Retry branch in PageBlockHost.handleRetry.
 */
export function isAuthTerminalStatus(status: PageHostStatus): boolean {
  return status === 'error' || status === 'no_token';
}

export type AutoRetryDecision =
  | { kind: 'none' }
  | {
      kind: 'retry';
      /** 1-based index of the attempt being scheduled. */
      attempt: number;
      /**
       * The highest attempt number still reachable FROM HERE, given the current
       * status. This is what the UI must show as the denominator — NOT the raw
       * `MAX_AUTO_RETRIES`. On an auth terminal the sequence is bounded by the
       * (lower) re-mint budget, so advertising the attempt cap would promise the
       * user a retry that will never happen: a fresh auth failure gets
       * "attempt 1 of 1", not "attempt 1 of 2". Derived rather than passed in, so
       * the copy cannot drift from the bound that actually governs it.
       */
      maxAttempts: number;
      delayMs: number;
      /** Whether this attempt spends a token re-mint. */
      remint: boolean;
    };

/**
 * Decide whether the host should schedule another AUTOMATIC load attempt.
 *
 * Pure so every bound is unit-testable without driving the real 10s/15s timer
 * windows, and so the two consumers can never disagree: the scheduling effect
 * (which arms the backoff timer) and the render-FAILURE beacon (which must stay
 * silent while the host has not settled — see the beacon-semantics note in
 * PageBlockHost) both read THIS function.
 *
 * Returns `{kind:'none'}` — i.e. the host has SETTLED on this terminal state — when:
 *   - the status is non-terminal (loading/ready) or not auto-retryable;
 *   - the total attempt budget is spent;
 *   - the status is an AUTH terminal and either (a) the re-mint budget is spent,
 *     or (b) no re-mint is wired (`canRemint:false`). In both cases a further
 *     attempt is a GUARANTEED re-fail (a remount can't change an upstream token),
 *     so retrying would waste the user's time and, in case (a), the rate limit.
 */
export function decideAutoRetry(args: {
  status: PageHostStatus;
  /** Automatic attempts already performed this mount. */
  attempts: number;
  /** Automatic attempts already performed that spent a re-mint. */
  reminted: number;
  /** Whether the host actually has a token re-mint available (`onRetryToken`). */
  canRemint: boolean;
}): AutoRetryDecision {
  const { status, attempts, reminted, canRemint } = args;
  if (!isAutoRetryableStatus(status)) return { kind: 'none' };
  if (attempts >= MAX_AUTO_RETRIES) return { kind: 'none' };

  const remint = isAuthTerminalStatus(status);
  if (remint && (!canRemint || reminted >= MAX_AUTO_REMINTS)) return { kind: 'none' };

  const delayMs =
    AUTO_RETRY_BACKOFF_MS[attempts] ?? AUTO_RETRY_BACKOFF_MS[AUTO_RETRY_BACKOFF_MS.length - 1];

  // The reachable ceiling FROM HERE. An auth terminal can only continue while it
  // has re-mint budget, so its ceiling is the attempts already spent plus the
  // re-mints still available — clamped by the attempt cap. A non-auth terminal is
  // governed by the attempt cap alone. This keeps a MIXED sequence honest too: a
  // timeout followed by an auth failure has already spent an attempt but no
  // re-mint, so it correctly reads "attempt 2 of 2".
  //
  // Proven never to under-promise: the auth branch is only reached while
  // `reminted < MAX_AUTO_REMINTS`, so `MAX_AUTO_REMINTS - reminted >= 1` and the
  // result is always `>= attempt`. 🔴 It CAN still shrink across renders if the
  // caps are ever widened past `MAX_AUTO_RETRIES === MAX_AUTO_REMINTS + 1` (e.g.
  // 4 and 2: a timeout shows "1 of 4", a following auth failure "2 of 3"). Today's
  // constants make that unreachable; revisit this line if they change.
  const maxAttempts = remint
    ? Math.min(MAX_AUTO_RETRIES, attempts + (MAX_AUTO_REMINTS - reminted))
    : MAX_AUTO_RETRIES;

  return { kind: 'retry', attempt: attempts + 1, maxAttempts, delayMs, remint };
}

// ── MID-SESSION CREDENTIAL-LOSS render beacon ────────────────────────────────
//
// 🔴 THE GAP THIS CLOSES (measured on production 2026-07-31): a real revocation
// teardown was driven end-to-end against a live app and the platform recorded
// ZERO error beacons. Its only record of the incident was the earlier,
// successful `ok` impression — so from the metric's point of view the app was
// perfectly healthy while it was, in fact, dead in every viewer's tab.
//
// WHY IT WAS ZERO. The host's ONE-beacon-per-mount rule is enforced by a single
// emit-once ref shared by the `ok` impression and the launch-FAILURE beacon.
// A host that reached `ready` has already spent that ref on `ok`, so when the
// `tokenTerminal` effect later tears it down to `error`, the failure beacon is
// inert BY CONSTRUCTION — not by accident, and not fixable by relaxing the ref
// (that would retroactively double-count impressions and corrupt the denominator
// the alert is built on, which is "page loads").
//
// THE FIX IS A SECOND, INDEPENDENT AT-MOST-ONCE CHANNEL. The mid-session beacon
// gets its OWN ref, so:
//   - the `ok` impression already sent is untouched (analytics unchanged);
//   - the teardown is reported exactly once per mount;
//   - it is tagged `token_lost_midsession`, which no launch failure can emit,
//     so the two are trivially separable in PromQL.
// A mount that loses its credential mid-session therefore emits TWO beacons —
// `ok` then `error{error_class="token_lost_midsession"}` — and that is the
// intended, documented shape: they describe two DIFFERENT events (the load
// succeeded; the session was later revoked), not one event counted twice.

/** Inputs to the mid-session credential-loss beacon decision. */
export type MidSessionLossBeaconArgs = {
  /** The COMMITTED host status (never read inside a setStatus updater). */
  status: PageHostStatus;
  /** True once this mount has observed `status === 'ready'` at least once. */
  reachedReady: boolean;
  /** `useBlockToken.terminal`: the mint has PERMANENTLY failed. */
  tokenTerminal: boolean;
  /** Whether a usable token remains. */
  hasToken: boolean;
  /** Whether this mount's mid-session beacon has ALREADY been emitted. */
  alreadyEmitted: boolean;
};

/**
 * Decide whether to emit the mid-session credential-loss render beacon.
 *
 * TRUE requires ALL of:
 *   1. `reachedReady` — the block DID launch. Without this the failure is a
 *      LAUNCH failure, already covered by the existing failure beacon under its
 *      own class ('error'/'no_token'/…); emitting here too would double-count.
 *   2. `status === 'error'` — the host has actually been torn down. `'error'` is
 *      reachable from exactly two places in PageBlockHost: `loading → error`
 *      (launch-time mint failure) and `ready → error` (this case). Requiring
 *      `reachedReady` picks out the second. Deliberately NOT `'fatal'` /
 *      `'timeout'` / `'no_token'`: those describe the BLOCK failing, not its
 *      credential being revoked, and mis-tagging them would make the class lie.
 *   3. `tokenTerminal && !hasToken` — the credential loss is SETTLED. The
 *      upstream hook retries a failed refresh on a bounded backoff and keeps a
 *      still-valid token while it does, so a transient blip must never reach
 *      here. This mirrors the teardown effect's own gate exactly: emitting on a
 *      weaker condition than the one that tore the host down would report an
 *      event that never happened to the user.
 *   4. `!alreadyEmitted` — at most once per mount, independent of the impression
 *      ref. Re-renders (token prop churn, retry-budget updates) re-run the
 *      effect; without this every one of them would fire another beacon.
 */
export function shouldEmitMidSessionLossBeacon(args: MidSessionLossBeaconArgs): boolean {
  const { status, reachedReady, tokenTerminal, hasToken, alreadyEmitted } = args;
  if (alreadyEmitted) return false;
  if (!reachedReady) return false;
  if (status !== 'error') return false;
  if (!tokenTerminal || hasToken) return false;
  return true;
}

/**
 * The `errorClass` the mid-session beacon carries. Distinct from every
 * launch-failure class so `sum by(error_class)` separates "never launched" from
 * "launched, then revoked".
 *
 * 🔴 MUST be a member of KNOWN_ERROR_CLASSES in
 * `~/server/metrics/app-block-runtime.metrics` — the beacon route clamps anything
 * else to 'other', which would silently merge this signal back into the generic
 * bucket. Pinned by a test in `__tests__/pageBlockHostLogic.test.ts`.
 */
export const MID_SESSION_LOSS_ERROR_CLASS = 'token_lost_midsession';
