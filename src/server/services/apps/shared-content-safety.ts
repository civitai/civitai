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
 *   - C2 (stored XSS): shared text is PLAIN TEXT. We HTML-escape on write (store
 *     escaped) so a stored `<script>` can never execute even if a
 *     featured/verified app is later granted `allow-same-origin`. The block still
 *     treats it as untrusted on read; escape-at-rest is the belt.
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

/**
 * HTML-escape a plain-text field for storage-at-rest (C2). We STORE the escaped
 * form so the value is inert on every render path. `&` first so we don't
 * double-escape the entities we introduce.
 */
export function escapeSharedText(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
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
 * `SharedContentBlockedError` on any block. Returns the HTML-escaped, store-ready
 * `{ title, body }` on success.
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

  // M1 — blocked link domains. `throwOnBlockedLinkDomain` throws a plain Error.
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

  return { title: escapeSharedText(title), body: body != null ? escapeSharedText(body) : undefined };
}
