import { LAB_LABELS, type LabEntityType, type LabLabel } from '../text-scan-lab/types';

/** The eval set for `label:model-com-face-intent`. 0, the placeholder until that set exists, matches no set. */
export const INTENT_EVAL_SET_ID = 0;

export const INTENT_LABEL = 'model-com-face-intent' satisfies LabLabel;
export const INTENT_LABELS: readonly LabLabel[] = [INTENT_LABEL];

/** The main-app permission that publishes new intent prompt text; every change to the pinned set needs it. */
export const INTENT_PUBLISH_PERMISSION = 'textScanPromptPublishIntent';

export const isIntentEvalSet = (setId: number) => setId === INTENT_EVAL_SET_ID;

export const caseLabels = (setId: number, entityType: LabEntityType): readonly LabLabel[] =>
  isIntentEvalSet(setId) ? INTENT_LABELS : LAB_LABELS[entityType];
