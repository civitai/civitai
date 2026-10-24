import { foldStepTypeCase } from '~/server/services/blocks/steps/orchestrator-denylist';
import { TRAINING_STEP_TYPES, type TrainingStepType } from '~/server/services/blocks/steps/output';
import {
  collectBlockStepTemplates,
  REPEAT_SHAPE_ERROR,
} from '~/server/services/blocks/workflow-graph';

// ONE trigger-word rule for every App Blocks carrier of a training run: `kind:'training'`,
// a pass-through `kind:'step'` and each step of a `kind:'workflow'` (a `repeat` template
// included). The router checks what this collects, before any quote or reservation.

/**
 * The input field that carries each training `$type`'s trigger word: `training` sends
 * `triggerWord`; `imageResourceTraining` has none and sends it as `loraName`, as the
 * Training Studio does. Keyed by every `TRAINING_STEP_TYPES` member, so a new training
 * `$type` does not compile until its field is named here.
 */
const TRIGGER_WORD_FIELD: Readonly<Record<TrainingStepType, string>> = {
  training: 'triggerWord',
  imageResourceTraining: 'loraName',
};
const TRIGGER_WORD_FIELD_BY_FOLDED_TYPE = new Map<string, string>(
  TRAINING_STEP_TYPES.map((type) => [foldStepTypeCase(type), TRIGGER_WORD_FIELD[type]])
);
const REF_KEY = '$ref';

function trainingTriggerWordNotStringMessage(field: string): string {
  return `a training step’s ${field} must be a literal string`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The trigger words of every training step `steps` can run — `triggerWord` of a
 * `training` step, `loraName` of an `imageResourceTraining` step — or the refusal when one
 * cannot be read for certain: a non-string value (a `$ref` included), an input that is
 * itself a reference, or a `repeat` that cannot be followed. `$type` and keys are matched
 * case-insensitively, so a differently cased field is read rather than skipped.
 */
export function collectTrainingTriggerWords(
  steps: ReadonlyArray<{ $type: string; input: unknown }>
): { triggerWords: string[] } | { error: string } {
  const triggerWords: string[] = [];
  for (const step of steps) {
    const templates = collectBlockStepTemplates(step.$type, step.input);
    if (templates === null) return { error: REPEAT_SHAPE_ERROR };
    for (const template of templates) {
      const field = TRIGGER_WORD_FIELD_BY_FOLDED_TYPE.get(foldStepTypeCase(template.$type));
      if (field === undefined || template.input === undefined) continue;
      const notString = { error: trainingTriggerWordNotStringMessage(field) };
      if (!isPlainObject(template.input)) return notString;
      for (const [key, value] of Object.entries(template.input)) {
        // An input that is itself a reference resolves to an object nothing here can read.
        if (key.toLowerCase() === REF_KEY) return notString;
        if (key.toLowerCase() !== field.toLowerCase()) continue;
        if (typeof value !== 'string') return notString;
        triggerWords.push(value);
      }
    }
  }
  return { triggerWords };
}
