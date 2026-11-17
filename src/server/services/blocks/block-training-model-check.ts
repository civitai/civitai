import { isTrainingStepTypeIgnoringCase } from '~/server/services/blocks/steps/orchestrator-denylist';
import {
  collectBlockStepTemplates,
  REPEAT_SHAPE_ERROR,
} from '~/server/services/blocks/workflow-graph';
import type { TrainingServiceStatus } from '~/server/services/blocks/block-training-quote.service';
import { trainingModelInfo } from '~/utils/training';
import { modelUnavailability, unavailableModelMessage } from '~/utils/training-blocked-models';

// The training-model rule for a raw training `$type` an app names itself — a pass-through
// `kind:'step'` and each step of a `kind:'workflow'` (a `repeat` template included).
// `kind:'training'` resolves its run through `resolveBlockTrainingRun`, which applies the
// same gates to a catalog key.

/** The input fields that name a training step's base model. */
const MODEL_FIELDS = ['engine', 'ecosystem', 'modelVariant', 'model'] as const;
type ModelField = (typeof MODEL_FIELDS)[number];

/** What one training step says about its base model; a field may be given more than once in different cases. */
export type TrainingStepModelFields = Record<ModelField, string[]>;

const FIELD_BY_FOLDED_KEY = new Map<string, ModelField>(
  MODEL_FIELDS.map((field) => [field.toLowerCase(), field])
);
const REF_KEY = '$ref';

function notStringError(field: string): { error: string } {
  return { error: `a training step’s ${field} must be a literal string` };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The base-model fields of every training step `steps` can run, or the refusal when one
 * cannot be read for certain: a non-string value (a `$ref` included), an input that is itself
 * a reference, or a `repeat` that cannot be followed. `$type` and keys are matched
 * case-insensitively, as `collectTrainingTriggerWords` matches them.
 */
export function collectTrainingStepModels(
  steps: ReadonlyArray<{ $type: string; input: unknown }>
): { models: TrainingStepModelFields[] } | { error: string } {
  const models: TrainingStepModelFields[] = [];
  for (const step of steps) {
    const templates = collectBlockStepTemplates(step.$type, step.input);
    if (templates === null) return { error: REPEAT_SHAPE_ERROR };
    for (const template of templates) {
      if (!isTrainingStepTypeIgnoringCase(template.$type) || template.input === undefined) continue;
      if (!isPlainObject(template.input)) return notStringError('input');
      const fields: TrainingStepModelFields = {
        engine: [],
        ecosystem: [],
        modelVariant: [],
        model: [],
      };
      for (const [key, value] of Object.entries(template.input)) {
        if (key.toLowerCase() === REF_KEY) return notStringError('input');
        const field = FIELD_BY_FOLDED_KEY.get(key.toLowerCase());
        if (field === undefined || value === undefined || value === null) continue;
        if (typeof value !== 'string') return notStringError(field);
        fields[field].push(value);
      }
      models.push(fields);
    }
  }
  return { models };
}

/**
 * The `source:id@version` an AIR names, lowercased and without its format, so the short
 * (`civitai:1@2`) and full (`urn:air:sd1:checkpoint:civitai:1@2`) forms compare equal.
 */
function airIdentity(air: string): string {
  const segments = air.trim().toLowerCase().split(':');
  const identity = segments.slice(-2).join(':');
  return identity.replace(/(@[^@.]+)\.[a-z]+$/, '$1');
}

// The ai-toolkit ecosystems whose `model` AIR picks the trainer base (`buildAiToolkitTrainingStep`
// sends it only for these); every other ecosystem trains its catalog base whatever `model` says.
const MODEL_AIR_ECOSYSTEMS: ReadonlySet<string> = new Set(['sd1', 'sdxl', 'anima']);

// An entry with no `modelVariant` also owns any variant its ecosystem's other entries do not
// name, so an invented variant cannot step around a blocked or disabled entry.
const CATALOG_VARIANTS_BY_ECOSYSTEM = new Map<string, Set<string>>();
for (const info of Object.values(trainingModelInfo)) {
  const toolkit = info.aiToolkit;
  if (!toolkit?.modelVariant) continue;
  const ecosystem = toolkit.ecosystem.toLowerCase();
  const variants = CATALOG_VARIANTS_BY_ECOSYSTEM.get(ecosystem) ?? new Set<string>();
  variants.add(toolkit.modelVariant.toLowerCase());
  CATALOG_VARIANTS_BY_ECOSYSTEM.set(ecosystem, variants);
}

const BLOCKED_CUSTOM_MODEL_MESSAGE =
  'This model has been blocked from training - please try another one.';

/**
 * The refusal for a raw training step, or `null` when it may run. The gates `kind:'training'`
 * and the training form apply: the training service is available, and the base model is
 * neither blocked in `training:status` nor disabled in the catalog, nor a blocked custom model.
 *
 * A step names a catalog base model when its AIR is that entry's, or when it is an ai-toolkit
 * step of that entry's ecosystem and variant — sending no AIR or that entry's AIR, where the
 * ecosystem's AIR picks the base.
 */
export function trainingStepModelRefusal(
  models: readonly TrainingStepModelFields[],
  status: TrainingServiceStatus
): string | null {
  if (models.length === 0) return null;
  if (!status.available) return status.message ?? 'Training is currently disabled';

  const blockedAirs = new Set((status.blockedModels ?? []).map(airIdentity));
  for (const step of models) {
    const airs = step.model.map(airIdentity);
    if (airs.some((air) => blockedAirs.has(air))) return BLOCKED_CUSTOM_MODEL_MESSAGE;

    const isAiToolkit = step.engine.some((engine) => engine.toLowerCase() === 'ai-toolkit');
    const ecosystems = step.ecosystem.map((value) => value.toLowerCase());
    const variants = step.modelVariant.map((value) => value.toLowerCase());

    for (const [key, info] of Object.entries(trainingModelInfo)) {
      const keyAir = airIdentity(info.air);
      const sendsKeyAir = airs.includes(keyAir);
      const toolkit = info.aiToolkit;
      const namesToolkitEntry =
        isAiToolkit &&
        toolkit !== undefined &&
        ecosystems.includes(toolkit.ecosystem.toLowerCase()) &&
        (toolkit.modelVariant === undefined
          ? variants.length === 0 ||
            variants.some(
              (variant) =>
                !CATALOG_VARIANTS_BY_ECOSYSTEM.get(toolkit.ecosystem.toLowerCase())?.has(variant)
            )
          : variants.includes(toolkit.modelVariant.toLowerCase())) &&
        (!MODEL_AIR_ECOSYSTEMS.has(toolkit.ecosystem) || airs.length === 0 || sendsKeyAir);
      if (!sendsKeyAir && !namesToolkitEntry) continue;

      if (info.disabled) return `${info.pretty} is not available for training.`;
      const unavailable = modelUnavailability(status, key);
      if (unavailable) return unavailableModelMessage(info.pretty, unavailable.reason);
    }
  }
  return null;
}
