import type { PanelVisibility } from './account-panel';
import type { PanelContext } from './panels';
import { CONTENT_RELATED_FEATURE } from './routing';

/** The page grant under which a user's open reports are read. `/reports` is a shared-access section, so
 *  `canAccess` resolves this sub-path to the grant of `/reports`, the one the report queues are gated on. */
export const USER_REPORTS_PATH = '/reports/user';

/** The page grant of User Lookup, under which a user's image removals are read. */
export const IMAGE_REMOVALS_PATH = '/retool/user-lookup';

/** Rows shown per section of the content card; each read asks for one more so a cut is told from a total. */
export const CONTENT_ROWS = 10;

/** Support-view tickets about content get the reports and removals on the sender; one with no linked user gets a note. */
export function contentPanelFor(ticket: PanelContext): PanelVisibility {
  if (ticket.view !== 'support') return 'hidden';
  if (ticket.cfFeature?.trim() !== CONTENT_RELATED_FEATURE) return 'hidden';
  return ticket.civitaiUserId === null ? 'unlinked' : 'panel';
}
