import { includesMinor, includesPoi } from '~/utils/metadata/audit';
import { throwOnBlockedLinkDomain } from '~/server/services/blocklist.service';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';

/**
 * BLOCKING content-safety belt for App Blocks SHARED storage writes (hardened
 * design C2 / C3 / M1 / M3).
 *
 * Shared rows are cross-user PUBLIC user-generated text rendered in OTHER users'
 * browsers + host-side surfaces (mod queue, activity feed, notifications). This is
 * the entire new abuse surface, so every `append` runs this SYNCHRONOUSLY before a
 * row can land:
 *   - C2 (stored XSS): shared text is PLAIN TEXT and is STORED RAW. Escape-at-rest
 *     was REMOVED (2026-07 security review): it was the WRONG layer. Apps render the
 *     value as React TEXT (children) and the host forwards `value` as DATA over
 *     postMessage — there is NO HTML render path (no `dangerouslySetInnerHTML` /
 *     `innerHTML` / `.html()` sink consumes it), so escaping only made stored
 *     entities display LITERALLY (a title `Tom & Jerry <3` rendered as
 *     `Tom &amp; Jerry &lt;3`). XSS containment now rests on (b) text-render and
 *     (c) the opaque-origin sandbox — all approved apps are `unverified` → no
 *     `allow-same-origin`, so even an injected `<script>` runs in an origin that
 *     can't touch civitai. The raw text is STILL run through the full block below
 *     (minor/POI/link/audit/size) — only the entity-escape of the stored form is
 *     gone.
 *     🔴 GATE-2 (pre-GA): a STRUCTURAL opaque-origin pin MUST be enforced before any
 *     `verified`/`internal`-tier app is ever granted `apps:storage:shared:*` — a
 *     verified app receives `allow-same-origin`, and escape-at-rest was the only
 *     belt for that case. Do not grant a shared scope to a non-`unverified` tier
 *     until that pin exists.
 *   - C3 (illegal content): `includesMinor` / `includesPoi` are a HARD legal fail
 *     (minor/POI/CSAM signals) — reject + the caller files a Report. Then
 *     `auditPromptServer` runs the full platform audit (regex + external
 *     moderation) and routes repeat abuse into the EXISTING auto-mute machinery,
 *     closing the loop with the trust gate.
 *   - M1 (link abuse): `throwOnBlockedLinkDomain` rejects blocked link domains; no
 *     server-side unfurl is ever performed.
 *   - M3 (size): tight caps (title ≤ 200 chars, body ≤ a few KB) — enforced by the
 *     router's zod schema AND re-asserted here as defence-in-depth.
 *
 * FORCED-SFW: shared community text is audited with `isGreen: true` (the stricter
 * SFW + profanity ceiling), mirroring the dev-tunnel forced-SFW posture — a
 * community app must not become an NSFW-text channel.
 */

// M3 — tight caps. Also enforced by the router zod schema; duplicated here so a
// future caller can't skip the schema and bypass the ceiling.
export const SHARED_TITLE_MAX = 200;
export const SHARED_BODY_MAX = 4096;

export type SharedBlockedCategory = 'minor' | 'poi' | 'link' | 'audit' | 'size';

/**
 * Thrown by `assertSharedTextSafe` when the text is rejected. Carries the
 * `category` so the caller can decide whether to file a Report (minor/poi/audit)
 * before converting to a user-facing TRPCError. NEVER leak the raw matched word to
 * the client beyond the audit machinery's own message.
 */
export class SharedContentBlockedError extends Error {
  readonly category: SharedBlockedCategory;
  constructor(category: SharedBlockedCategory, message: string) {
    super(message);
    this.name = 'SharedContentBlockedError';
    this.category = category;
  }
}

export interface SharedTextSafetyInput {
  title: string;
  body?: string;
  /** Token subject — the abuse principal for auto-mute accounting. */
  userId: number;
  /** From the hydrated subject; moderators skip the auto-mute side effect. */
  isModerator?: boolean;
}

/**
 * Runs the full BLOCKING safety belt on shared write text. Throws
 * `SharedContentBlockedError` on any block. Returns the RAW, store-ready
 * `{ title, body }` on success (see the C2 note above — the value is stored
 * un-escaped and XSS is contained at the render + sandbox layers, NOT at rest).
 */
export async function assertSharedTextSafe(
  input: SharedTextSafetyInput
): Promise<{ title: string; body?: string }> {
  const { title, body, userId, isModerator } = input;

  // M3 — belt re-check (the schema is the primary gate).
  if (title.length > SHARED_TITLE_MAX) {
    throw new SharedContentBlockedError('size', 'Title exceeds the maximum length');
  }
  if (body != null && body.length > SHARED_BODY_MAX) {
    throw new SharedContentBlockedError('size', 'Body exceeds the maximum length');
  }

  const combined = body ? `${title}\n${body}` : title;

  // C3 — HARD legal fail FIRST. These signals (minor age / POI / CSAM composites)
  // must reject + Report regardless of the account's mute state. Kept ahead of the
  // general audit so a minor/POI hit is unambiguously classified for the caller's
  // Report filing.
  if (includesMinor(combined)) {
    throw new SharedContentBlockedError('minor', 'Content flagged for review');
  }
  if (includesPoi(combined)) {
    throw new SharedContentBlockedError('poi', 'Content flagged for review');
  }

  // M1 — blocked link domains. `throwOnBlockedLinkDomain` throws (a BAD_REQUEST
  // TRPCError); the bare catch re-wraps any throw into SharedContentBlockedError.
  try {
    await throwOnBlockedLinkDomain(combined);
  } catch {
    throw new SharedContentBlockedError('link', 'Content contains a blocked link');
  }

  // C3 — full platform audit (regex + external moderation) + the EXISTING
  // auto-mute machinery (repeat blocked-prompt accounting → mute). isGreen:true
  // forces the SFW + profanity ceiling for community text. `track` omitted (the
  // block-token path has no request Tracker); auditPromptServer guards on it.
  try {
    await auditPromptServer({
      prompt: combined,
      userId,
      isGreen: true,
      isModerator,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Content was flagged';
    throw new SharedContentBlockedError('audit', message);
  }

  // Store RAW (Fix 2 / 2026-07 security review): escape-at-rest was removed — see
  // the C2 note. Every safety control above ran on the raw text; the returned value
  // is the un-escaped, store-ready form.
  return { title, body: body != null ? body : undefined };
}
