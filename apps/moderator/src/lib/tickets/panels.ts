import { accountPanelFor, type AccountPanel } from './account-panel';
import type { TicketView } from './routing';

/** What decides whether a panel applies to a ticket. */
export type PanelContext = {
  view: TicketView;
  cfFeature: string | null | undefined;
  routerTopic: string | null | undefined;
  civitaiUserId: number | null;
};

export type PanelVisibility = AccountPanel;

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
} satisfies Record<string, PanelSpec>;

export type PanelKey = keyof typeof PANELS;
