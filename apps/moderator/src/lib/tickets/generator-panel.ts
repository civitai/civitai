import type { PanelVisibility } from './account-panel';
import type { PanelContext } from './panels';
import { IMAGE_GENERATOR_FEATURE } from './routing';

/** The page grant of User Lookup, under which a user's blocked prompts are read. */
export const BLOCKED_PROMPTS_PATH = '/retool/user-lookup';

/** Rows shown per section of the generator card; each read asks for one more so a cut is told from a total. */
export const GENERATOR_ROWS = 10;

/** Support-view tickets about the image generator get the sender's restrictions and blocked prompts; one with no linked user gets a note. */
export function generatorPanelFor(ticket: PanelContext): PanelVisibility {
  if (ticket.view !== 'support') return 'hidden';
  if (ticket.cfFeature?.trim() !== IMAGE_GENERATOR_FEATURE) return 'hidden';
  return ticket.civitaiUserId === null ? 'unlinked' : 'panel';
}
