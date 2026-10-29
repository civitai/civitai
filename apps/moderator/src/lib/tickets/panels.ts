import { accountPanelFor, type PanelVisibility } from './account-panel';
import { APPEAL_QUEUE_PATHS } from './appeals';
import { appealsPanelFor } from './appeals-panel';
import { RATINGS_PATH } from './rating-disputes';
import type { TicketView } from './routing';

/** What decides whether a panel applies to a ticket. */
export type PanelContext = {
  view: TicketView;
  cfFeature: string | null | undefined;
  routerTopic: string | null | undefined;
  civitaiUserId: number | null;
  /** The subject and description, for panels that mark what the ticket links to. */
  text?: string;
};

export type PanelSpec = {
  /** The viewer needs at least one of these page grants to read the panel; none held hides it. */
  readGrants: readonly string[];
  visibility: (ticket: PanelContext) => PanelVisibility;
};

/**
 * The context panels of a ticket, keyed by the key of the payload section they fill. A panel is shown
 * to a viewer holding one of its `readGrants`; the server loads it lazily, only when it applies
 * (`$lib/server/tickets/panels`).
 */
export const PANELS = {
  account: {
    readGrants: ['/retool/user-lookup'],
    visibility: accountPanelFor,
  },
  appeals: {
    readGrants: APPEAL_QUEUE_PATHS,
    visibility: appealsPanelFor,
  },
  // Read-only: the lists User Lookup shows, under its grant. Held on the tickets the Appeals card shows on.
  history: {
    readGrants: ['/retool/user-lookup'],
    visibility: appealsPanelFor,
  },
  ratingDisputes: {
    readGrants: [RATINGS_PATH],
    visibility: appealsPanelFor,
  },
} satisfies Record<string, PanelSpec>;

export type PanelKey = keyof typeof PANELS;
