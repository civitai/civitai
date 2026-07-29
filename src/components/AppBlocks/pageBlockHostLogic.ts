// Pure logic for PageBlockHost (W10 full-page apps). Extracted so the two
// security/UX-load-bearing decisions are unit-testable in the node vitest env
// (no RTL — civitai-web's unit project runs `environment: 'node'` and only
// collects `*.test.ts`). Mirrors the IframeHost `hostRenderDecision` pattern.

export type PageHostStatus =
  | 'loading'
  | 'ready'
  | 'timeout'
  | 'fatal'
  | 'no_token'
  | 'error';

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

/**
 * Issue B (defensive UX): decide whether a REQUEST_CONSENT whose grantable set is
 * EMPTY should surface a user-visible "not available in this preview" message
 * instead of the silent no-op that makes an app look dead.
 *
 * A block MAY send an advisory `scopes` hint listing what it wants. The host does
 * NOT use it to GRANT anything (the grant set is bounded server-side to
 * `missingScopes`), but it CAN use it to tell apart two otherwise-identical
 * silent-drop cases when nothing is grantable-via-consent:
 *   - BENIGN (drop silently): every requested scope is ALREADY granted — a block
 *     re-requesting a scope its token already carries.
 *   - UN-GRANTABLE (surface a message): a requested scope is neither currently
 *     granted NOR addable via consent (`missingScopes`) — it was clamped/withheld
 *     at mint (e.g. a dev-tunnel token that stripped a scope the tunnel allowlist
 *     doesn't carry), so the block's consent round-trip can never resolve it.
 *
 * Returns the un-grantable subset (requested − granted − missing), sorted+deduped.
 * Returns EMPTY when the hint is absent/garbage OR everything requested is already
 * granted — the caller then keeps the silent no-op (no fragile heuristic: without
 * an explicit requested scope proven un-grantable, we never toast).
 */
export function resolveUngrantableConsentScopes(
  rawScopesHint: unknown,
  grantedScopes: string[],
  missingScopes: string[] | undefined
): string[] {
  if (!Array.isArray(rawScopesHint)) return [];
  const requested = rawScopesHint.filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  );
  if (requested.length === 0) return [];
  const granted = new Set<string>(grantedScopes);
  const missing = new Set<string>(missingScopes ?? []);
  return Array.from(
    new Set(requested.filter((s: string) => !granted.has(s) && !missing.has(s)))
  ).sort();
}

// ── OPEN_RESOURCE_PICKER (Design 1 host-chrome resource picker) ──────────────
//
// The page block asks the HOST to open its native ResourceSelectModal so the
// viewer can DISCOVER a generation resource (checkpoint / LoRA). The iframe
// never sees the catalog — only the single picked resource comes back via
// RESOURCE_PICKER_RESULT. This generalizes the model-slot OPEN_CHECKPOINT_PICKER
// (IframeHost) from Checkpoint-only to a typed allowlist.
//
// v1 type allowlist: Checkpoint + LoRA ONLY (matches the page-LoRA v1 body
// contract — model.type LORA → additionalResources, Checkpoint → modelVersionId).
// Any other requested type is REJECTED (the request is dropped, the modal never
// opens) so a block can't open an embeddings/VAE/wildcards picker on a page.

/** Canonical model-type tokens the page resource picker accepts in v1. */
export const PAGE_RESOURCE_PICKER_TYPES = ['Checkpoint', 'LORA'] as const;
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
 * 'LoRA'); the returned `resourceType` is the canonical token the native modal
 * filter expects ('Checkpoint' | 'LORA').
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

  return { requestId: obj.requestId, resourceType: canonical, ...(baseModelGroup ? { baseModelGroup } : {}) };
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
    ? obj.imageIds.filter(
        (n): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0
      )
    : [];
  return { requestId: obj.requestId, imageIds };
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
