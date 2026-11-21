import { Air } from '@civitai/orchestration-client';
import { TRPCError } from '@trpc/server';
import { dbRead } from '~/server/db/client';
import { assertNoRestrictedBaseModels } from '~/server/services/blocks/app-base-model-licence';
import {
  argumentPathValues,
  FIELD_KEY_RE,
  FREE_TEXT_KEYS,
  isMediaKey,
  readArgumentsRepeatClause,
} from '~/server/services/blocks/app-step-positions';
import { MEDIA_INPUT_NAMES as COMFY_MEDIA_INPUT_NAMES } from '~/server/services/blocks/inline-comfy.service';
import { WORKFLOW_ARGUMENTS_REF } from '~/server/services/blocks/workflow-graph';
import { BLOB_KEY_RE } from '~/server/services/blocks/media-input-reference';
import { isWeightFile } from '~/server/services/huggingface.service';
import { capsGenerationOutput } from '~/server/services/orchestrator/form-graph/output-restrictions';
import { canAccessGenerationResource } from '~/server/utils/resource-access';

// The resource rule for an orchestrator step an app builds itself: a pass-through `kind:'step'`,
// every step of a `kind:'workflow'`, and a customComfy graph. Apps load weights only from Civitai
// model versions: a version carries the base model that the licence block and the mature cap read.
// Anything else is refused wherever it appears in the input, keys included (LoRAs are a map keyed
// by AIR). A training-data zip from a Hugging Face dataset repo is exempt: it is not weights.

// Whitespace-free, so a prompt that mentions the site is not mistaken for a resource.
const HUGGING_FACE_RE = /^\S*huggingface\S*$/i;
const AIR_URN_RE = /^urn:air:/i;
const HUGGING_FACE_TRAINING_DATA_RE =
  /^urn:air:other:other:huggingface:datasets\/[\w.-]+\/[\w.-]+@[\w.-]+\/[\w./-]+\.zip$/i;
// A URL: a loader can take one in place of an AIR, so one naming a weights file is refused.
// `https:host/x` is a URL too: the WHATWG parser supplies the missing slashes.
const URL_RE = /^([a-z][a-z0-9+.-]*:\/\/|https?:)/i;
// Job outputs the orchestrator itself produced (a trained LoRA, a previous step's file), and mail
// links, which the AIR grammar also matches.
const ALLOWED_NON_CIVITAI_SOURCES: ReadonlySet<string> = new Set(['orchestrator', 'mailto']);

function refuse(message: string): never {
  throw new TRPCError({ code: 'FORBIDDEN', message });
}

function namesWeightsFile(url: string): boolean {
  try {
    return isWeightFile(decodeURIComponent(new URL(url).pathname));
  } catch {
    return true;
  }
}

// Hosts and paths the orchestrator reads as a file in storage, whatever the extension.
const STORAGE_HOST_SUFFIXES = [
  'r2.cloudflarestorage.com',
  'digitaloceanspaces.com',
  'backblazeb2.com',
];
const STORAGE_HOSTS: ReadonlySet<string> = new Set(['image.civitai.com']);
const STORAGE_HOST_FIRST_LABELS: ReadonlySet<string> = new Set(['blobs-b2', 'image-b2']);
// On any host, with or without a version segment.
const STORAGE_PATH_RE = /\/(consumer|providers)\/blobs\//i;
const STORED_FILE_DEPTH_MAX = 64;
// Controls and spaces at either end, which a URL parser drops.
const EDGE_CONTROLS_RE = /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g;
// Characters a URL parser drops anywhere: tab and newlines, and bidi and format controls.
const DROPPED_RE = /[\t\n\r\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** The string as a URL parser reads it. */
function asParsed(value: string): string {
  return value.replace(DROPPED_RE, '').trim().replace(EDGE_CONTROLS_RE, '');
}

/** Every scalar in `value` as a format writes it (null as empty), map keys included. */
function scalarLeaves(value: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length) {
    const node = stack.pop();
    if (node === null || node === undefined) out.push('');
    else if (typeof node === 'string') out.push(node);
    else if (typeof node === 'number' || typeof node === 'boolean') out.push(String(node));
    else if (Array.isArray(node)) stack.push(...node);
    else if (typeof node === 'object') for (const [k, v] of Object.entries(node)) stack.push(k, v);
  }
  return out;
}

// The characters formats may be filled out to in one input; more is refused unread.
const FORMAT_FILL_BUDGET = 1_000_000;

/** The items a repeat iterates: the arrays its clause reaches, or null when it reaches none. */
function loopItemsOf(values: unknown[] | null): unknown[] | null {
  const arrays = values?.filter(Array.isArray) ?? [];
  return arrays.length ? arrays.flat() : null;
}

/** `format` with every placeholder group written as `value`, as a composite format would. */
function formatWith(format: string, value: string): string {
  return format
    .replace(/\{[^{}]*\}/g, value)
    .split('{{')
    .join('{')
    .split('}}')
    .join('}');
}

function namesStoredFile(url: string): boolean {
  let parsed: URL;
  try {
    // Only the scheme-relative form gets a scheme: `https:host/x` must keep its host.
    parsed = url.startsWith('//') ? new URL(`https:${url}`) : new URL(url);
  } catch {
    // A parser more lenient than this one may still read the path.
    return STORAGE_PATH_RE.test(url.replace(/\\/g, '/').replace(/\/{2,}/g, '/'));
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (STORAGE_HOSTS.has(host) || STORAGE_HOST_FIRST_LABELS.has(host.split('.')[0])) return true;
  if (STORAGE_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return true;
  let path = parsed.pathname;
  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    } catch {
      return true;
    }
  }
  return STORAGE_PATH_RE.test(path.replace(/\\/g, '/').replace(/\/{2,}/g, '/'));
}

/** A ComfyUI node: its id is the app's choice and names no field. */
function isComfyNode(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  return typeof node.class_type === 'string' && !!node.inputs && typeof node.inputs === 'object';
}

function isComfyMediaInput(key: string): boolean {
  const name = key.toLowerCase();
  return name !== 'model_file' && COMFY_MEDIA_INPUT_NAMES.has(name);
}

type Where = {
  key: string | undefined;
  depth: number;
  /** Inside a ComfyUI node: its media input names count, and free text is not exempt. */
  comfy?: boolean;
  /** Every leaf lands at `key`, whatever the names inside. */
  flat?: boolean;
  /** The value is a workflow's `steps` array or a repeat's `template`: each entry is a step. */
  stepList?: boolean;
  step?: boolean;
  /** The value is the input's `workflow`: a ComfyUI graph keyed by node id. */
  graph?: boolean;
};

/**
 * Refuses a stored file URL, or a blob key at a `*BlobKey` field, anywhere but a media input. Free
 * text is exempt outside a ComfyUI graph. A workflow's `arguments` have no position of their own: a
 * `$arguments` reference, and a repeat's loop variable, is judged where it lands. Not gated by the
 * step position flag.
 */
function assertStoredFilesAtMediaInputs(input: unknown, workflow: boolean) {
  const workflowArguments =
    workflow && input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>).arguments
      : undefined;
  // The items a repeat places through its loop variable, by name (lower-cased); null when this
  // check cannot read its clause, so a reference to it places every argument.
  const loopItems = new Map<string, unknown[] | null>();
  let formatFill = 0;

  const visit = (value: unknown, where: Where): void => {
    const { key, depth, comfy = false, flat = false } = where;
    if (key !== undefined) {
      // In a graph only its own media input names count: a node's `url` input may load weights.
      if (comfy ? isComfyMediaInput(key) : isMediaKey(key)) return;
      if (!comfy && FREE_TEXT_KEYS.has(key.toLowerCase())) return;
    }
    if (depth > STORED_FILE_DEPTH_MAX) refuse('step input is nested too deeply');
    const at = (child: unknown, extra: Partial<Where> = {}) =>
      visit(child, { key, depth: depth + 1, comfy, flat, ...extra });
    if (typeof value === 'string') {
      const trimmed = asParsed(value);
      if ((URL_RE.test(trimmed) || trimmed.startsWith('//')) && namesStoredFile(trimmed))
        refuse(
          'a stored file URL is accepted only at a media input; model weights must be a Civitai model version'
        );
      if (/blob(key|id)$/i.test(key ?? '') && BLOB_KEY_RE.test(trimmed))
        refuse('a blob key is accepted only at a media input');
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) at(item, { step: !!where.stepList });
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    if (flat) {
      for (const [childKey, child] of entries) {
        at(childKey);
        at(child);
      }
      return;
    }
    const refKey = entries.find(([k]) => k.toLowerCase() === '$ref')?.[0];
    if (refKey !== undefined) {
      // The orchestrator passes a reference's `default` on, and an object not spelled exactly as a
      // reference as plain data, so every value here lands at this key.
      for (const [, v] of entries) at(v);
      const target = record[refKey];
      if (typeof target !== 'string') return;
      const field = (name: string) => entries.find(([k]) => k.toLowerCase() === name)?.[1];
      const path = field('path');
      const name = target.toLowerCase();
      const format = field('format');
      // The orchestrator may write any value that lands here, a default or nothing into the format.
      const fillFormat = (from: unknown) => {
        if (typeof format !== 'string') return;
        for (const leaf of ['', ...scalarLeaves(from)]) {
          formatFill += format.length + leaf.length;
          if (formatFill > FORMAT_FILL_BUDGET) refuse('step input is too large to check');
          at(formatWith(format, leaf));
        }
      };
      fillFormat(field('default'));
      // Every leaf lands here, and any of them may be written into the format.
      const placeFlat = (from: unknown) => {
        at(from, { flat: true });
        fillFormat(from);
      };
      let placed: unknown[] | null;
      if (name === WORKFLOW_ARGUMENTS_REF.toLowerCase())
        placed = argumentPathValues(path, workflowArguments, { wide: true });
      else if (loopItems.has(name)) {
        const items = loopItems.get(name);
        if (!items) return placeFlat(workflowArguments);
        placed =
          path === undefined || path === ''
            ? items
            : typeof path === 'string'
            ? items.flatMap((item) => argumentPathValues(path, item, { wide: true }) ?? [])
            : null;
        if (!placed) return placeFlat(items);
      } else return; // Another step's output is not known yet; the position rule judges it.
      if (!placed) return placeFlat(workflowArguments);
      for (const one of placed) {
        at(one);
        // The argument may be written into the format, so the two are judged together.
        fillFormat(one);
      }
      return;
    }
    if (where.graph) {
      for (const [nodeId, node] of entries) {
        if (!isComfyNode(node)) {
          at(node);
          continue;
        }
        at(nodeId, { key: undefined });
        for (const [field, v] of Object.entries(node))
          if (field === 'inputs') visit(v, { key: undefined, depth: depth + 2, comfy: true });
          else visit(v, { key: field, depth: depth + 2, comfy: true });
      }
      return;
    }
    // A repeat step on a workflow arm: its `for` clause names the items its template places.
    const isRepeat =
      workflowArguments !== undefined &&
      !!where.step &&
      typeof record.$type === 'string' &&
      record.$type.toLowerCase() === 'repeat';
    const repeatInput =
      isRepeat && record.input && typeof record.input === 'object' ? record.input : null;
    const clause = repeatInput ? (repeatInput as Record<string, unknown>).for : undefined;
    const read = readArgumentsRepeatClause(clause);
    // Wider than the position rule on purpose: this check judges every reading of the path.
    const loop = read
      ? {
          name: read.as.toLowerCase(),
          items: loopItemsOf(argumentPathValues(read.path, workflowArguments, { wide: true })),
        }
      : null;
    for (const [childKey, child] of entries) {
      if (depth === 0 && workflowArguments !== undefined && childKey === 'arguments') continue;
      const isField = FIELD_KEY_RE.test(childKey);
      // A map key the app chose can name a file too (LoRAs are keyed by AIR).
      if (!isField) at(childKey);
      const childWhere: Partial<Where> = { key: isField ? childKey : key };
      if (depth === 0 && childKey === 'workflow') childWhere.graph = true;
      if (workflowArguments !== undefined && depth === 0 && childKey === 'steps')
        childWhere.stepList = true;
      if (loop && childKey === 'input') {
        visitRepeatInput(child as Record<string, unknown>, loop, depth + 1, comfy);
        continue;
      }
      at(child, childWhere);
    }
  };

  const visitRepeatInput = (
    repeatInput: Record<string, unknown>,
    loop: { name: string; items: unknown[] | null },
    depth: number,
    comfy: boolean
  ) => {
    const clause = repeatInput.for as Record<string, unknown>;
    // The clause's own strings are judged; its items are judged where the template places them.
    visit(clause.path, { key: 'for', depth: depth + 1, comfy });
    visit(clause.as, { key: 'for', depth: depth + 1, comfy });
    const hadOuter = loopItems.has(loop.name);
    const shadowed = loopItems.get(loop.name);
    // A reused name may bind either loop, so it places both loops' items.
    loopItems.set(
      loop.name,
      !loop.items || (hadOuter && !shadowed) ? null : [...(shadowed ?? []), ...loop.items]
    );
    try {
      for (const [childKey, child] of Object.entries(repeatInput)) {
        if (childKey === 'for') continue;
        const isField = FIELD_KEY_RE.test(childKey);
        if (!isField) visit(childKey, { key: 'input', depth: depth + 1, comfy });
        visit(child, {
          key: isField ? childKey : 'input',
          depth: depth + 1,
          comfy,
          stepList: childKey === 'template',
          step: childKey === 'template',
        });
      }
    } finally {
      if (hadOuter) loopItems.set(loop.name, shadowed ?? null);
      else loopItems.delete(loop.name);
    }
  };

  visit(input, { key: undefined, depth: 0 });
}

function versionIdOf(air: string, parsed: { version?: string }): number {
  const version = Number(parsed.version);
  if (!Number.isSafeInteger(version) || version <= 0)
    refuse(`a Civitai resource must name a model version: '${air.slice(0, 200)}'`);
  return version;
}

/** The Civitai versions `input` names, or a refusal for any other resource. */
function collectAppStepVersionIds(input: unknown): number[] {
  const versionIds = new Set<number>();
  // A map key can only name a resource (LoRAs are keyed by AIR), so it gets no benefit of the doubt.
  const visitString = (raw: string, isKey: boolean) => {
    const value = raw.trim();
    if (HUGGING_FACE_TRAINING_DATA_RE.test(value)) return;
    if (HUGGING_FACE_RE.test(value))
      refuse('Hugging Face resources are not available to apps; use a Civitai model version');
    const parsed = Air.parseSafe(value);
    const source = parsed?.source.toLowerCase();
    // Before the URL test: the AIR grammar also reads `https:civitai:1@2` as a Civitai version.
    if (parsed && source === 'civitai') {
      versionIds.add(versionIdOf(value, parsed));
      return;
    }
    if (URL_RE.test(value)) {
      if (isKey || namesWeightsFile(value))
        refuse('model weights must be a Civitai model version, not a URL');
      return;
    }
    if (!parsed || !source) {
      if (AIR_URN_RE.test(value)) refuse(`unreadable resource AIR: '${value.slice(0, 200)}'`);
      return;
    }
    // Timecodes and ratios (`00:00:05:00`) parse too; no resource host is a number.
    if (/^\d+$/.test(source)) return;
    // The orchestrator reads the `urn:air:` prefix as optional, but the bare `source:id` form
    // also matches ordinary words, so as a value it counts only with a version.
    const isResource =
      isKey || AIR_URN_RE.test(value) || (!!parsed.ecosystem && !!parsed.type) || !!parsed.version;
    if (isResource && !ALLOWED_NON_CIVITAI_SOURCES.has(source))
      refuse(`resource source '${source}' is not available to apps; use a Civitai model version`);
  };
  const visit = (value: unknown) => {
    if (typeof value === 'string') visitString(value, false);
    else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) {
        visitString(key, true);
        visit(item);
      }
  };
  visit(input);
  return [...versionIds];
}

/**
 * Refuses an app-built step input that names a resource other than a Civitai model version, a
 * version the viewer may not generate with, or a version on a base model no app may use, and
 * returns whether its output is held to PG-13.
 *
 * Only the generation check's access rule applies here, without its moderator exemption, and not
 * its coverage or base-model rules: training steps name base checkpoints that are not covered for
 * generation.
 *
 * A step that names no resource (a provider API, or an engine's default weights) is not capped
 * here: its `ecosystem` string is the orchestrator's spelling and does not map back to one base
 * model, so such a step relies on the provider's own refusal.
 */
export async function checkAppStepResources(
  input: unknown,
  viewerId: number,
  /** `input` is a whole workflow body, whose `arguments` its steps' references read. */
  opts: { workflow?: boolean } = {}
): Promise<{ capOutput: boolean }> {
  assertStoredFilesAtMediaInputs(input, !!opts.workflow);
  const versionIds = collectAppStepVersionIds(input);
  const versions = versionIds.length
    ? await dbRead.modelVersion.findMany({
        where: { id: { in: versionIds } },
        select: {
          id: true,
          baseModel: true,
          status: true,
          availability: true,
          usageControl: true,
          model: { select: { userId: true } },
        },
      })
    : [];
  const found = new Set(versions.map((v) => v.id));
  const missing = versionIds.find((id) => !found.has(id));
  if (missing !== undefined) refuse(`model version ${missing} is not available for generation`);

  // 🔴 No isModerator: the app's code names these resources, not the viewer, so a moderator's
  // rights must not reach a third-party or pending app.
  const denied = versions.find(
    (v) => !canAccessGenerationResource({ ...v, modelUserId: v.model.userId }, { id: viewerId })
  );
  if (denied) refuse(`model version ${denied.id} is not available for generation`);

  const baseModels = versions.map((v) => v.baseModel);
  assertNoRestrictedBaseModels({ baseModels });
  return { capOutput: capsGenerationOutput({ baseModels }) };
}
