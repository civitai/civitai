import { IMAGE_GENERATOR_FEATURE } from './routing';
import { USER_LOOKUP_PATH, supportFeaturePanel } from './support-feature';

/** The page grant of User Lookup, under which a user's blocked prompts are read. */
export const BLOCKED_PROMPTS_PATH = USER_LOOKUP_PATH;

/** Rows shown per section of the generator card; each read asks for one more so a cut is told from a total. */
export const GENERATOR_ROWS = 10;

/** Support-view tickets about the image generator get the sender's restrictions and blocked prompts; one with no linked user gets a note. */
export const generatorPanelFor = supportFeaturePanel(IMAGE_GENERATOR_FEATURE);
