import { LORA_TRAINER_FEATURE } from './routing';
import { supportFeaturePanel } from './support-feature';

/** The page grant of the training models page, which gates the card's read and its publish-block write. */
export const TRAINING_MODELS_PATH = '/audit/training-models';

/** Runs shown on the LoRA card; the read is bounded to this and says when it cut. */
export const LORA_ROWS = 10;

/** Support-view tickets about the LoRA trainer get the sender's training runs; one with no linked user gets a note. */
export const loraPanelFor = supportFeaturePanel(LORA_TRAINER_FEATURE);
