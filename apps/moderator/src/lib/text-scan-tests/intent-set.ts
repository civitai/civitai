import { LAB_LABELS, type LabEntityType, type LabLabel } from '../text-scan-lab/types';

/**
 * The pinned eval set for the civitai.com face intent check (`label:model-com-face-intent`): the only
 * set whose runs ask for that label, and the set a publish of that prompt must pass. A code constant,
 * so repointing it is a reviewed PR, never a setting a set editor can change. 0 matches no set.
 */
export const INTENT_EVAL_SET_ID = 0;

export const INTENT_LABEL = 'model-com-face-intent' satisfies LabLabel;
export const INTENT_LABELS: readonly LabLabel[] = [INTENT_LABEL];

/** The main-app permission that publishes new intent prompt text; every change to the pinned set needs it. */
export const INTENT_PUBLISH_PERMISSION = 'textScanPromptPublishIntent';

export const isIntentEvalSet = (setId: number) => setId === INTENT_EVAL_SET_ID;

/** The labels a case in this set is scored on: the intent label alone in the pinned set. */
export const caseLabels = (setId: number, entityType: LabEntityType): readonly LabLabel[] =>
  isIntentEvalSet(setId) ? INTENT_LABELS : LAB_LABELS[entityType];
