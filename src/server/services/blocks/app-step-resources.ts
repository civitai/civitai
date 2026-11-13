import { Air } from '@civitai/orchestration-client';
import { TRPCError } from '@trpc/server';
import { dbRead } from '~/server/db/client';
import { assertNoRestrictedBaseModels } from '~/server/services/blocks/app-base-model-licence';
import { isWeightFile } from '~/server/services/huggingface.service';
import { capsGenerationOutput } from '~/server/services/orchestrator/form-graph/output-restrictions';

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
    if (URL_RE.test(value)) {
      if (isKey || namesWeightsFile(value))
        refuse('model weights must be a Civitai model version, not a URL');
      return;
    }
    const parsed = Air.parseSafe(value);
    if (!parsed) {
      if (AIR_URN_RE.test(value)) refuse(`unreadable resource AIR: '${value.slice(0, 200)}'`);
      return;
    }
    const source = parsed.source.toLowerCase();
    if (source === 'civitai') {
      versionIds.add(versionIdOf(value, parsed));
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
 * Refuses an app-built step input that names a resource other than a Civitai model version, or a
 * version on a base model no app may use, and returns whether its output is held to PG-13.
 *
 * A step that names no resource (a provider API, or an engine's default weights) is not capped
 * here: its `ecosystem` string is the orchestrator's spelling and does not map back to one base
 * model, so such a step relies on the provider's own refusal.
 */
export async function checkAppStepResources(input: unknown): Promise<{ capOutput: boolean }> {
  const versionIds = collectAppStepVersionIds(input);
  const versions = versionIds.length
    ? await dbRead.modelVersion.findMany({
        where: { id: { in: versionIds } },
        select: { id: true, baseModel: true },
      })
    : [];
  const found = new Set(versions.map((v) => v.id));
  const missing = versionIds.find((id) => !found.has(id));
  if (missing !== undefined) refuse(`model version ${missing} is not available for generation`);

  const baseModels = versions.map((v) => v.baseModel);
  assertNoRestrictedBaseModels({ baseModels });
  return { capOutput: capsGenerationOutput({ baseModels }) };
}
