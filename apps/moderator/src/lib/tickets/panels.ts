import { GENERATOR_RESTRICTIONS_PATH } from '$lib/restriction-types';
import { accountPanelFor, type PanelVisibility } from './account-panel';
import { APPEAL_QUEUE_PATHS } from './appeals';
import { appealsPanelFor } from './appeals-panel';
import { IMAGE_REMOVALS_PATH, USER_REPORTS_PATH, contentPanelFor } from './content-panel';
import { BLOCKED_PROMPTS_PATH, generatorPanelFor } from './generator-panel';
import { TRAINING_MODELS_PATH, loraPanelFor } from './lora-panel';
import { RATINGS_PATH } from './rating-disputes';
import type { TicketView } from './routing';
import { supportAccountPanelFor } from './support-account-panel';
import { USER_LOOKUP_PATH, membershipPanelFor, shopPanelFor } from './support-panels';

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
  // Support view. Each section of the card reads under its own source page's grant; the panel shows for either.
  contentIssue: {
    readGrants: [USER_REPORTS_PATH, IMAGE_REMOVALS_PATH],
    visibility: contentPanelFor,
  },
  generator: {
    readGrants: [GENERATOR_RESTRICTIONS_PATH, BLOCKED_PROMPTS_PATH],
    visibility: generatorPanelFor,
  },
  lora: {
    readGrants: [TRAINING_MODELS_PATH],
    visibility: loraPanelFor,
  },
  // The Account card without its actions, for Account Login and Email Change tickets.
  supportAccount: {
    readGrants: ['/retool/user-lookup'],
    visibility: supportAccountPanelFor,
  },
  // Read-only cards of User Lookup's sources, under its page grant.
  membership: {
    readGrants: [USER_LOOKUP_PATH],
    visibility: membershipPanelFor,
  },
  shop: {
    readGrants: [USER_LOOKUP_PATH],
    visibility: shopPanelFor,
  },
} satisfies Record<string, PanelSpec>;

export type PanelKey = keyof typeof PANELS;
