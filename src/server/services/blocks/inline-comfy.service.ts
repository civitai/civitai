import { TRPCError } from '@trpc/server';
import { getResourceData } from '~/server/services/generation/generation.service';
import { getHighestTierSubscription } from '~/server/services/subscriptions.service';
import { Availability } from '~/shared/utils/prisma/enums';
import { AIR_URN_PREFIX } from '~/server/services/blocks/steps';
import type { ComfyGraph } from '~/server/services/blocks/recipes';

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks customComfy INLINE-GRAPH belt.
//
// An inline body (`kind:'customComfy'`, `mode:'inline'`) carries the ComfyUI
// graph itself instead of naming a code-reviewed recipe. Code review WAS the
// trust root for the recipe path; this module is what replaces it mechanically.
// Three gates, all fail-closed, all THROWING (never returning a verdict a caller
// can forget to read):
//
//   1. `assertInlineGraphAirsDeclared` — containment. Every AIR appearing
//      anywhere in the graph must also appear in the declared `resources` array,
//      so gating that array is gating everything.
//   2. `assertViewerEntitledToInlineResources` — entitlement over `resources`.
//   3. `collectInlineAuditText` — the moderation sweep (see below).
//
// 🔴 WHY THE ENTITLEMENT SURFACE IS A FLAT `string[]` AND NOT THE GRAPH.
// `CustomComfyInput.resources` is the orchestrator's DECLARED DOWNLOAD MANIFEST
// — "All resources the workflow needs, declared explicitly as AIR URNs …
// Anything the workflow references that isn't listed here will fail at load time
// inside ComfyUI" — while `CustomComfyInput.workflow` is "Forwarded opaquely to
// the worker; the orchestrator does not inspect or validate node contents"
// (both from the generated `@civitai/client` types). So the untrusted
// entitlement surface is that array, and it does not need graph parsing.
//
// 🔴 THAT CLAIM IS TRUSTED BUT NOT DEPENDED ON. It comes from a doc comment on a
// generated type, not from observed orchestrator behaviour. Gate 1 above is what
// makes it non-load-bearing: if the orchestrator ever DID resolve an AIR the
// graph names but `resources` omits, containment has already rejected that body.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🔴 NODEPACK AIRs ARE ARBITRARY CODE EXECUTION, AND ARE OFF FOR THIS INCREMENT.
 *
 * `CustomComfyInput.resources` accepts `comfy:nodepack` URNs (e.g.
 * `urn:air:comfy:nodepack:comfyregistry:<owner>/<pack>@<version>`), which install
 * third-party custom nodes into the ComfyUI container at runtime. Allowing an app
 * to name one is allowing an app to run code we have not reviewed, sandboxed only
 * by the worker container. That is a product/security decision with a named owner,
 * and it has NOT been made — so this ships CLOSED rather than shipping the
 * decision by default.
 *
 * Consequence, stated plainly: inline graphs are limited to STOCK ComfyUI nodes
 * plus non-nodepack AIRs. An app needing a custom node pack is still blocked.
 *
 * Enabling it later is a one-line flip, and the tests for both states already
 * exist (`inline-comfy.service.test.ts` covers rejection now, and the
 * allowlist derivation below is keyed off this flag so nothing else moves).
 */
export const INLINE_NODEPACKS_ENABLED = false;

/**
 * AIR `source` values an inline `resources` entry may name. ALLOWLIST, not a
 * denylist — an unrecognised source is a resource class nobody has reasoned
 * about, and the fail-closed answer is to reject it.
 *
 * `civitai` carries civitai entitlement and is gated below. `huggingface` is the
 * public-weights source both shipped recipes already pin (see the `staticAirs`
 * in `recipes/seamless-pano.recipe.ts`), so it is exempt-by-construction: there
 * is no civitai entitlement to check on a public HF repo.
 */
const INLINE_ALLOWED_AIR_SOURCES: ReadonlySet<string> = new Set(
  INLINE_NODEPACKS_ENABLED
    ? ['civitai', 'huggingface', 'comfyregistry']
    : ['civitai', 'huggingface']
);

/**
 * AIR `type` values an inline `resources` entry may name — model WEIGHTS only.
 *
 * 🔴 THIS IS NOT DERIVED FROM `shared/utils/air.ts`'s `typeUrnMap`, AND THAT IS
 * DELIBERATE. That map is the civitai `ModelType` → URN direction and does not
 * cover the URN spellings the orchestrator actually accepts: both shipped
 * recipes pin `diffusion_model` and `text_encoders` (underscored), which
 * `typeUrnMap` does not contain (it has `diffusionmodel` / `text_encoders`
 * inconsistently). Deriving from it would reject the platform's own live AIRs.
 *
 * Two exclusions are the point of the list, not incidental:
 *   - `nodepack` — arbitrary code execution (see INLINE_NODEPACKS_ENABLED).
 *   - `image`    — an `urn:air:oci:image:…` OCI container image. `comfyImage` is
 *                  already unsettable via the wire schema's `.strict()`; this
 *                  stops the same capability arriving through `resources`.
 */
const INLINE_ALLOWED_AIR_TYPES: ReadonlySet<string> = new Set([
  'checkpoint',
  'diffusion_model',
  'diffusionmodel',
  'unet',
  'lora',
  'lycoris',
  'dora',
  'embedding',
  'hypernet',
  'controlnet',
  'vae',
  'upscaler',
  'clip',
  'clipvision',
  'text_encoders',
  'motion',
  'ag',
  'visionlanguage',
  ...(INLINE_NODEPACKS_ENABLED ? ['nodepack'] : []),
]);

/**
 * Recursion budget for the graph walk. Same value and the same fail-closed
 * posture as `AIR_SCAN_MAX_DEPTH` in `services/blocks/steps` (which is module-
 * private there): an unbounded recursion over attacker-shaped JSON hits
 * `RangeError: Maximum call stack size exceeded` at ~5k levels, which a small
 * `[[[[…]]]]` body reaches trivially — a free 500 from a value the guard was
 * supposed to DECIDE on. At the cap we THROW a BAD_REQUEST, i.e. "I could not
 * prove this graph is safe to run", never a silent partial walk.
 */
const INLINE_GRAPH_MAX_DEPTH = 128;

/**
 * Max characters of graph-derived text handed to the prompt audit.
 *
 * 🔴 EXCEEDING IT REJECTS, IT DOES NOT TRUNCATE. Truncating would be a
 * moderation bypass by construction — put the disallowed text past the cutoff.
 * The wire schema's `INLINE_GRAPH_BYTES_MAX` already bounds the graph well below
 * anything that should reach this, so this is a backstop, not a routine limit.
 */
const INLINE_AUDIT_TEXT_MAX = 20_000;

function badRequest(message: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message });
}

/**
 * One total walk over the graph, collecting every STRING that appears anywhere —
 * as a leaf, an array element, an object VALUE, **or an object KEY**.
 *
 * 🔴 KEYS ARE WALKED, AND THAT IS THE ORCHESTRATOR'S OWN SCHEMA, NOT PARANOIA.
 * `ImageJobParams.additionalNetworks` is documented "Use the AIR of the network
 * as the key" and `WorkflowCost.fees` is likewise AIR-keyed, so a walk over
 * `Object.values` alone misses the single most likely real placement of an AIR.
 * This mirrors `containsAirReference` (`services/blocks/steps`) exactly — same
 * shape, but COLLECTING instead of returning a boolean.
 *
 * Both consumers below need this same walk, so it runs ONCE.
 */
export function collectInlineGraphStrings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > INLINE_GRAPH_MAX_DEPTH) {
    throw badRequest('inline workflow is nested too deeply to inspect');
  }
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectInlineGraphStrings(v, depth + 1, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      collectInlineGraphStrings(key, depth + 1, out);
      collectInlineGraphStrings(v, depth + 1, out);
    }
  }
  return out;
}

/**
 * CONTAINMENT: every AIR appearing in the graph must also be declared in
 * `resources`. Without this, `resources` is not the whole entitlement surface
 * and gating it proves nothing.
 *
 * 🔴 THE MATCH IS WHOLE-STRING, NOT SUBSTRING-EXTRACTION, AND THAT IS STRICTER
 * ON PURPOSE. A string that merely CONTAINS `urn:air:` must equal a declared AIR
 * outright (trimmed, case-insensitively). Reconstructing the AIR grammar with a
 * regex to pull a URN out of a longer string would create a second, drifting
 * copy of that grammar — and any mismatch between the extractor and what the
 * worker actually resolves is exactly the bypass this gate exists to close. A
 * real ComfyUI graph carries the bare AIR as an input value (`unet_name`,
 * `lora_name`), so whole-string is what the legitimate case already does.
 */
export function assertInlineGraphAirsDeclared(graph: ComfyGraph, declared: string[]): void {
  const declaredSet = new Set(declared.map((a) => a.trim().toLowerCase()));
  for (const s of collectInlineGraphStrings(graph)) {
    const lowered = s.toLowerCase();
    if (!lowered.includes(AIR_URN_PREFIX)) continue;
    if (!declaredSet.has(lowered.trim())) {
      throw badRequest(
        `inline workflow references an AIR that is not declared in resources: '${s.slice(0, 200)}'`
      );
    }
  }
}

/**
 * The text handed to `auditPromptServer` for an inline body.
 *
 * 🔴 THIS IS THE WHOLE REASON MODERATION STILL WORKS ON THIS PATH. On the recipe
 * arm the audit reads `params.prompt`, a field the recipe's `.strict()` schema
 * guarantees exists. An inline graph carries its prompts as leaf strings inside
 * `CLIPTextEncode` nodes, so auditing a declared field alone would leave the
 * audit reading a value the generation does not use — moderation would become a
 * silent no-op while every gate stayed green. The declared prompt is audited
 * AND the graph is swept, so a clean declared prompt cannot launder a graph
 * prompt.
 *
 * Concatenation is sound here because the audit is a regex + external-classifier
 * scan over text: adding more text can only ADD triggers, never remove one. Leaves are
 * newline-joined so a trigger cannot be manufactured across a boundary that
 * exists in neither string.
 */
export function collectInlineAuditText(opts: { prompt: string; graph: ComfyGraph }): string {
  const leaves = collectInlineGraphStrings(opts.graph);
  // Deduped: a graph repeats class names and input keys on every node, and the
  // audit gains nothing from the hundredth 'CLIPTextEncode'.
  const seen = new Set<string>();
  const parts: string[] = [];
  if (opts.prompt.trim()) parts.push(opts.prompt);
  for (const leaf of leaves) {
    const t = leaf.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    parts.push(t);
  }
  const text = parts.join('\n');
  if (text.length > INLINE_AUDIT_TEXT_MAX) {
    throw badRequest(
      `inline workflow carries more text than can be moderated (${text.length} > ${INLINE_AUDIT_TEXT_MAX} characters)`
    );
  }
  return text;
}

type ParsedInlineAir = {
  raw: string;
  source: string;
  type: string;
  /** Present only for `source === 'civitai'` — a positive integer version id. */
  versionId?: number;
};

/**
 * STRICT AIR reader: `urn:air:<ecosystem>:<type>:<source>:<id>[@<version>]`.
 * All four segments REQUIRED. Case-insensitive on structure; `type` and `source`
 * are lowercased after extraction, `id`/`version` keep their case (a
 * huggingface id is case-sensitive, e.g. `black-forest-labs/FLUX.1-dev`).
 *
 * 🔴 WHY THIS IS NOT `Air.parseSafe` FROM `@civitai/client`, EVEN THOUGH THAT
 * EXISTS AND `shared/utils/air.ts` WRAPS IT. That parser is a LENIENT READER for
 * input we already trust; this is a GATE over input we do not. Measured against
 * `@civitai/client` 0.2.0-beta.84 by running it, its regex
 * (`^(?:urn:)?(?:air:)?(?:(?<ecosystem>…):)?(?:(?<type>…):)?(?<source>…):(?<id>…)…`)
 * has three properties that each fail OPEN here:
 *
 *   1. **The `urn:air:` prefix is OPTIONAL, and so are `ecosystem` and `type`.**
 *      `'sdxl:lora:civitai:118025@136251'` parses, and even `'foo:bar'` parses as
 *      `{source:'foo', id:'bar'}`. So "parseSafe returned a value" is NOT
 *      evidence the string is an AIR, and a `type`-based gate reads `undefined`
 *      for any string that omits it.
 *   2. **`source` is CASE-PRESERVING.** `'urn:air:sdxl:lora:CIVITAI:118025@136251'`
 *      parses with `source: 'CIVITAI'`. A case-SENSITIVE `source === 'civitai'`
 *      test routes that down the non-civitai branch and skips the entitlement
 *      belt entirely — a direct bypass.
 *   3. **`version` is an optional RAW STRING, not a number.**
 *      `'…:civitai:118025'` yields `undefined` and `'…:civitai:abc@def'` yields
 *      `'def'`; `Number()` on either is `NaN`. A `NaN` id resolves nothing in
 *      `getResourceData` and — through its silent-drop behaviour — reads as "no
 *      gated resources here".
 *
 * 🔴 A SECOND, STRICTER COPY OF THE GRAMMAR IS SAFE HERE, AND THE DIRECTION IS
 * WHY. A divergence between this reader and whatever the worker resolves can
 * only make this reader reject something the worker would have accepted — a
 * false REJECT, never a false accept. (The containment check deliberately does
 * NOT parse at all, for exactly the opposite reason: there a divergence would be
 * a bypass, so it compares whole strings.) `inline-comfy.service.test.ts` pins
 * this against the AIRs the SHIPPED recipes actually use, so over-strictness has
 * a test that goes red.
 */
const STRICT_AIR_RE =
  /^urn:air:([a-z0-9_\-/]+):([a-z0-9_\-/]+):([a-z0-9_\-/]+):([^@\s]+)(?:@(\S+))?$/i;

function parseInlineAir(raw: string): ParsedInlineAir {
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith(AIR_URN_PREFIX)) {
    throw badRequest(`resource is not an AIR URN: '${trimmed.slice(0, 200)}'`);
  }
  const match = STRICT_AIR_RE.exec(trimmed);
  if (!match) {
    throw badRequest(
      `resource is not a well-formed AIR URN: '${trimmed.slice(0, 200)}' — expected ` +
        'urn:air:<ecosystem>:<type>:<source>:<id>[@<version>]'
    );
  }
  const type = match[2].toLowerCase();
  const source = match[3].toLowerCase();
  const rawVersion: string | undefined = match[5];

  if (type === 'nodepack' && !INLINE_NODEPACKS_ENABLED) {
    throw badRequest(
      `nodepack resources are not permitted in an inline workflow: '${trimmed.slice(0, 200)}' ` +
        '— a node pack installs third-party code into the ComfyUI container at runtime'
    );
  }
  if (!INLINE_ALLOWED_AIR_TYPES.has(type)) {
    throw badRequest(
      `resource AIR type '${type || '(none)'}' is not permitted in an inline workflow`
    );
  }
  if (!INLINE_ALLOWED_AIR_SOURCES.has(source)) {
    throw badRequest(
      `resource AIR source '${source || '(none)'}' is not permitted in an inline workflow`
    );
  }

  if (source !== 'civitai') return { raw: trimmed, source, type };

  const version = rawVersion;
  if (!version || !/^\d+$/.test(version) || Number(version) <= 0) {
    throw badRequest(
      `civitai resource AIR must name a model VERSION id: '${trimmed.slice(0, 200)}' ` +
        '— without one there is no version to check entitlement against'
    );
  }
  return { raw: trimmed, source, type, versionId: Number(version) };
}

/**
 * THE ENTITLEMENT BELT for an app-supplied `resources` array. Returns nothing;
 * THROWS on any failure. Fail-closed throughout.
 *
 * 🔴 WHY THIS IS NOT `assertViewerCanGeneratePageResources`. That gate (used by
 * the recipe arm and the txt2img page path) runs `resolveCanGenerateForVersions`,
 * which covers baseline generatability — coverage, status, `usageControl`, NSFW
 * tier, hidden gates — and does NOT cover early-access `hasAccess` NOR
 * Private-model subscription. On the recipe path that was survivable because a
 * recipe may only pin fully-public versions and a human reviewed each one. An
 * inline graph removes exactly that protection, so this path uses
 * `getResourceData`, which folds `applyPaidAccessGating` internally
 * (`generation.service.ts`, and `paid-access-gating.ts` does
 * `canGenerate = hasAccess && canGenerate`) — early-access comes with it — plus
 * the Private/epoch subscription check, which does NOT live in `getResourceData`
 * and is ported here from the onsite belt (`validateAndEnrichResources` in
 * `services/orchestrator/orchestration-new.service`, which is not exported).
 *
 * 🔴 TWO SILENT FAIL-OPENS IN `getResourceData` THAT THIS FUNCTION EXISTS TO
 * CLOSE. A checker that iterates the RETURNED array and asserts `canGenerate`
 * passes VACUOUSLY on both:
 *
 *   A. **It DROPS unresolvable ids.** Its fetch does `if (!cached) return null`
 *      then `.filter(isDefined)`, so an id that resolves to nothing simply is
 *      not in the result — and "no bad resources in the array" is trivially true
 *      of an empty array. We assert PER REQUESTED ID that a row came back.
 *   B. **It SUBSTITUTES.** `getResourceDataSubstitutes` finds a covered,
 *      accessible sibling version of the same model for any resource that is
 *      `!covered || !hasAccess`, and attaches it as `resource.substitute`.
 *      Onsite that is graceful degradation; HERE it is a correctness bug, because
 *      the graph names one specific AIR string in `unet_name`/`lora_name` and
 *      nothing rewrites the graph. A present `substitute` is a REJECT.
 *      (Note the returned row keeps the REQUESTED id — the substitute is a
 *      sibling FIELD, not a replacement element. A gate that only checked
 *      "id came back" would miss this, which is why it is checked separately.)
 */
export async function assertViewerEntitledToInlineResources(opts: {
  airs: string[];
  user: { id: number; isModerator: boolean };
}): Promise<void> {
  const parsed = opts.airs.map(parseInlineAir);

  // Duplicate declarations are pointless and make the per-id accounting below
  // ambiguous; reject rather than silently dedupe.
  const rawSeen = new Set<string>();
  for (const p of parsed) {
    const key = p.raw.toLowerCase();
    if (rawSeen.has(key)) throw badRequest(`duplicate resource declared: '${p.raw.slice(0, 200)}'`);
    rawSeen.add(key);
  }

  const versionIds = parsed
    .map((p) => p.versionId)
    .filter((v): v is number => typeof v === 'number');
  if (versionIds.length === 0) return;

  const resources = await getResourceData(versionIds, {
    user: { id: opts.user.id, isModerator: opts.user.isModerator },
    generation: true,
  });
  const byId = new Map(resources.map((r) => [r.id, r]));

  for (const id of versionIds) {
    const resource = byId.get(id);
    // (A) anti-drop.
    if (!resource) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `model version ${id} is not available for generation`,
      });
    }
    // (B) anti-substitute. The graph pins a specific AIR; a different version is
    // not an acceptable answer here even though it is onsite.
    if (resource.substitute) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          `model version ${id} is not available for generation ` +
          '(a different version of that model is, but an inline workflow names a specific ' +
          'resource and is never silently substituted)',
      });
    }
    if (!resource.canGenerate) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `model version ${id} is not available for generation`,
      });
    }
  }

  // Private / epoch resources require an active subscription. Ported from the
  // onsite belt; NOT covered by `getResourceData`.
  const hasPrivateOrEpoch = resources.some(
    (r) => r.availability === Availability.Private || !!r.epochDetails
  );
  if (hasPrivateOrEpoch && !opts.user.isModerator) {
    const subscription = await getHighestTierSubscription(opts.user.id);
    if (!subscription) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Using Private resources requires an active subscription.',
      });
    }
  }

  // Expired epochs — same source, same posture.
  const expired = resources.find((r) => r.epochDetails?.isExpired);
  if (expired) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `model version ${expired.id} uses an epoch that has expired`,
    });
  }
}
