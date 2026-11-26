import { createHash } from 'node:crypto';
import * as z from 'zod';
import { SOURCE_IMAGE_URL_MAX } from '~/server/schema/blocks/civitai-image-url';
import { canonicalJson } from '~/server/services/blocks/block-quote-grant.service';
import { getRecipe, type RunnerSlotType } from '~/server/services/blocks/recipes';
import { timingSafeEqualStrings } from '~/server/utils/timing-safe-equal';

// Binds a runner submit to the run authorization it spends under (binding v1). The runner sends
// the authorized `customComfy` body with only its declared slot values filled in; the server
// derives two hashes from that request and compares them to the authorization row.

export const RUNNER_SLOTS_MAX = 8;
/** Stands in for a slot's value in both hashes. Never deleted: a missing key hashes differently. */
export const RUNNER_SLOT_SENTINEL = '\u0000civitai-runner-slot:v1';
const RUNNER_TEXT_SLOT_MAX = 4096;

export const runnerSlotsSchema = z
  .array(
    z.strictObject({
      path: z.string().min(2).max(256),
      type: z.enum(['image', 'text']),
    })
  )
  .max(RUNNER_SLOTS_MAX);
export type RunnerSlot = z.infer<typeof runnerSlotsSchema>[number];

type JsonObject = Record<string, unknown>;
/** The parsed `customComfy` body, either arm. */
export type RunnerBindingBody = JsonObject & { kind: 'customComfy'; mode?: string };

export type RunnerBindingRefusal = 'slots' | 'slot_path' | 'slot_value' | 'mismatch';

/** RFC 6901 tokens, or null for a malformed pointer. */
function pointerTokens(path: string): string[] | null {
  if (!path.startsWith('/')) return null;
  const tokens: string[] = [];
  for (const raw of path.slice(1).split('/')) {
    if (/~(?![01])/.test(raw)) return null;
    tokens.push(raw.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  return tokens;
}

/**
 * The inline-arm node inputs a slot may fill: `class_type` -> input -> slot type. Only image and
 * text inputs that cannot change a step's cost. Widening this is a cost review.
 */
export const RUNNER_INLINE_SLOT_INPUTS: Readonly<
  Record<string, Readonly<Record<string, RunnerSlotType>>>
> = {
  CLIPTextEncode: { text: 'text' },
  LoadImage: { image: 'image' },
};

/**
 * Where a slot may point. Inline arm: an allowlisted node input. Recipe arm: a `params` key the
 * recipe declares (`runnerSlots`). Both because the orchestrator does not hard-cap a step's
 * charge at its timeout, so a free cost input could raise what the run bills.
 */
function slotPathAllowed(body: RunnerBindingBody, tokens: string[], type: RunnerSlotType): boolean {
  if (body.mode === 'inline') {
    if (tokens.length !== 4 || tokens[0] !== 'workflow' || tokens[2] !== 'inputs') return false;
    const workflow = body.workflow as Record<string, { class_type?: unknown }> | undefined;
    const node = workflow && Object.hasOwn(workflow, tokens[1]) ? workflow[tokens[1]] : undefined;
    const inputs =
      typeof node?.class_type === 'string' &&
      Object.hasOwn(RUNNER_INLINE_SLOT_INPUTS, node.class_type)
        ? RUNNER_INLINE_SLOT_INPUTS[node.class_type]
        : undefined;
    return inputs != null && Object.hasOwn(inputs, tokens[3]) && inputs[tokens[3]] === type;
  }
  if (tokens.length !== 2 || tokens[0] !== 'params') return false;
  const recipe = typeof body.recipe === 'string' ? getRecipe(body.recipe) : undefined;
  const declared = recipe?.runnerSlots;
  return declared != null && Object.hasOwn(declared, tokens[1]) && declared[tokens[1]] === type;
}

/** The object holding the slot and its key, when every step is an own key of a plain object. */
function slotParent(
  body: JsonObject,
  tokens: string[]
): { parent: JsonObject; key: string } | null {
  let node: unknown = body;
  for (const token of tokens.slice(0, -1)) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return null;
    if (!Object.hasOwn(node, token)) return null;
    node = (node as JsonObject)[token];
  }
  const key = tokens[tokens.length - 1];
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return null;
  if (!Object.hasOwn(node, key)) return null;
  return { parent: node as JsonObject, key };
}

const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
// The image CDN's own path shape: /<account key>/<image uuid>/[<transform>/]<file>.<image ext>.
// Narrower than `isCivitaiHostedImageUrl` (any civitai host, any path), which would let a slot
// point the worker at a model download.
const IMAGE_CDN_HOST = 'image.civitai.com';
const IMAGE_CDN_PATH =
  /^\/[A-Za-z0-9_-]{22}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:[^/]+\/)?[^/]+\.(?:jpe?g|png|webp)$/i;

function isImageCdnUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === IMAGE_CDN_HOST &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    IMAGE_CDN_PATH.test(url.pathname)
  );
}
const MODEL_FILE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i;

function slotValueAllowed(value: unknown, type: RunnerSlotType): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  // A model is never a free slot: an AIR or a weights file name is refused whatever the type.
  if (/urn:air:/i.test(value) || MODEL_FILE.test(value)) return false;
  if (type === 'image') return value.length <= SOURCE_IMAGE_URL_MAX && isImageCdnUrl(value);
  // An embedding reference loads a model through the text encoder.
  if (/embedding:/i.test(value)) return false;
  return value.length <= RUNNER_TEXT_SLOT_MAX && !CONTROL_CHAR.test(value);
}

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export type RunnerBindingHashes = { recipeVersionHash: string; paramsHash: string };

/**
 * The two binding hashes of a runner request, or a refusal when its slots are malformed.
 * `ceiling` and `resources` are what the server computed from the request as sent, slot values
 * included, so a slot value that changes cost or model changes `paramsHash`.
 */
export function runnerBindingHashes(
  body: RunnerBindingBody,
  slots: readonly RunnerSlot[],
  cost: { ceiling: number; resources: readonly string[] }
): { ok: true; hashes: RunnerBindingHashes } | { ok: false; refusal: RunnerBindingRefusal } {
  for (let i = 1; i < slots.length; i += 1) {
    if (!(slots[i - 1].path < slots[i].path)) return { ok: false, refusal: 'slots' };
  }
  const blanked = structuredClone(body);
  if (blanked.mode === undefined) blanked.mode = 'recipe';
  for (const slot of slots) {
    const tokens = pointerTokens(slot.path);
    if (!tokens || !slotPathAllowed(blanked, tokens, slot.type)) {
      return { ok: false, refusal: 'slot_path' };
    }
    const at = slotParent(blanked, tokens);
    if (!at) return { ok: false, refusal: 'slot_path' };
    if (!slotValueAllowed(at.parent[at.key], slot.type))
      return { ok: false, refusal: 'slot_value' };
    at.parent[at.key] = RUNNER_SLOT_SENTINEL;
  }
  const { params: _params, ...shape } = blanked;
  return {
    ok: true,
    hashes: {
      recipeVersionHash: sha256Hex({ v: 1, slots, body: shape }),
      paramsHash: sha256Hex({
        v: 1,
        body: blanked,
        ceiling: cost.ceiling,
        resources: [...cost.resources].sort(),
      }),
    },
  };
}

/** Whether a runner request matches its authorization. The refusal never says which hash differed. */
export function checkRunnerBinding(
  body: RunnerBindingBody,
  slots: readonly RunnerSlot[],
  cost: { ceiling: number; resources: readonly string[] },
  authorized: RunnerBindingHashes
): { ok: true } | { ok: false; refusal: RunnerBindingRefusal; derived?: RunnerBindingHashes } {
  const derived = runnerBindingHashes(body, slots, cost);
  if (!derived.ok) return derived;
  const recipeOk = timingSafeEqualStrings(
    derived.hashes.recipeVersionHash,
    authorized.recipeVersionHash
  );
  const paramsOk = timingSafeEqualStrings(derived.hashes.paramsHash, authorized.paramsHash);
  return recipeOk && paramsOk
    ? { ok: true }
    : { ok: false, refusal: 'mismatch', derived: derived.hashes };
}
