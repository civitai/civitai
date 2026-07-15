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
// an image (the app decides what it is for). The iframe never handles the bytes:
// they flow through civitai's session-authed upload → REAL scan → SFW/flag gate,
// and only a moderated image id (never above the SFW ceiling, never flagged) comes
// back via IMAGE_UPLOAD_RESULT. The only wire-validation is: require a string
// requestId (drop otherwise, never open the modal) — everything security-relevant
// (scan + SFW ceiling + flag rejection) is enforced server-side. Kept pure +
// unit-tested for the same reason as resolveResourcePickerRequest (the drop rule
// is the relevant part).

export type ImageUploadRequest = {
  requestId: string;
};

/**
 * Validate a raw OPEN_IMAGE_UPLOAD payload from an untrusted iframe. Returns the
 * sanitized request, or `null` when it must be DROPPED (missing/non-string
 * requestId). The CALLER opens the native upload modal — this only decides whether
 * to. There is no other client-side gate: the scan + SFW ceiling live server-side.
 */
export function resolveImageUploadRequest(raw: unknown): ImageUploadRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.requestId !== 'string' || obj.requestId.length === 0) return null;
  return { requestId: obj.requestId };
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
