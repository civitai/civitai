import { isTrainingStepTypeIgnoringCase } from '~/server/services/blocks/steps/orchestrator-denylist';
import {
  collectBlockStepTemplates,
  REPEAT_SHAPE_ERROR,
} from '~/server/services/blocks/workflow-graph';

// ONE trigger-word rule for every App Blocks carrier of a training run: `kind:'training'`,
// a pass-through `kind:'step'` and each step of a `kind:'workflow'` (a `repeat` template
// included). The router checks what this collects, before any quote or reservation.

const TRIGGER_WORD_KEY = 'triggerword';
const REF_KEY = '$ref';

export const TRAINING_TRIGGER_WORD_NOT_STRING =
  'a training step’s triggerWord must be a literal string';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The trigger words of every training step `steps` can run, or the refusal when one
 * cannot be read for certain: a non-string value (a `$ref` included), or a `repeat`
 * that cannot be followed. Keys are matched case-insensitively, so a differently
 * cased `triggerWord` is read rather than skipped.
 */
export function collectTrainingTriggerWords(
  steps: ReadonlyArray<{ $type: string; input: unknown }>
): { triggerWords: string[] } | { error: string } {
  const triggerWords: string[] = [];
  for (const step of steps) {
    const templates = collectBlockStepTemplates(step.$type, step.input);
    if (templates === null) return { error: REPEAT_SHAPE_ERROR };
    for (const template of templates) {
      if (!isTrainingStepTypeIgnoringCase(template.$type)) continue;
      if (template.input === undefined) continue;
      if (!isPlainObject(template.input)) return { error: TRAINING_TRIGGER_WORD_NOT_STRING };
      for (const [key, value] of Object.entries(template.input)) {
        // An input that is itself a reference resolves to an object nothing here can read.
        if (key.toLowerCase() === REF_KEY) return { error: TRAINING_TRIGGER_WORD_NOT_STRING };
        if (key.toLowerCase() !== TRIGGER_WORD_KEY) continue;
        if (typeof value !== 'string') return { error: TRAINING_TRIGGER_WORD_NOT_STRING };
        triggerWords.push(value);
      }
    }
  }
  return { triggerWords };
}
