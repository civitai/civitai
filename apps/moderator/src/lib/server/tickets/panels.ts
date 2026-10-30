import { ACCOUNT_APPEALS_PATH } from '$lib/tickets/appeals';
import { PANELS, type PanelContext, type PanelKey } from '$lib/tickets/panels';
import { accountSectionFor, type TicketAccount } from './account';
import { appealsSectionFor, type TicketAppeals } from './appeals';
import { contentIssueSectionFor, type TicketContentIssue } from './content-reports';
import { generatorSectionFor, type TicketGenerator } from './generator-restrictions';
import { historySectionFor, type TicketHistory } from './history';
import { loraSectionFor, type TicketLora } from './lora-runs';
import { ratingDisputesSectionFor, type TicketRatingDisputes } from './rating-disputes';

export type PanelSections = {
  account: TicketAccount;
  appeals: TicketAppeals;
  history: TicketHistory;
  ratingDisputes: TicketRatingDisputes;
  contentIssue: TicketContentIssue;
  generator: TicketGenerator;
  lora: TicketLora;
  supportAccount: TicketAccount;
};

export type CanRead = (path: string) => boolean;

type LinkedContext = PanelContext & { civitaiUserId: number };

type Loaders = {
  [K in PanelKey]: (
    ticket: LinkedContext,
    canRead: CanRead
  ) => Promise<PanelSections[K] | undefined>;
};

export const liveLoaders: Loaders = {
  account: ({ view, cfFeature, routerTopic, civitaiUserId }, canRead) =>
    accountSectionFor({
      view,
      cfFeature: cfFeature ?? null,
      routerTopic: routerTopic ?? null,
      civitaiUserId,
      canView: true,
      canAppeal: canRead(ACCOUNT_APPEALS_PATH),
    }),
  appeals: (ticket, canRead) =>
    appealsSectionFor({ userId: ticket.civitaiUserId, text: ticket.text ?? '', canRead }),
  history: ({ civitaiUserId }) => historySectionFor({ userId: civitaiUserId }),
  ratingDisputes: ({ civitaiUserId }) => ratingDisputesSectionFor({ userId: civitaiUserId }),
  contentIssue: ({ civitaiUserId }, canRead) =>
    contentIssueSectionFor({ userId: civitaiUserId, canRead }),
  generator: ({ civitaiUserId }, canRead) =>
    generatorSectionFor({ userId: civitaiUserId, canRead }),
  lora: ({ civitaiUserId }) => loraSectionFor({ userId: civitaiUserId }),
  supportAccount: ({ view, cfFeature, routerTopic, civitaiUserId }) =>
    accountSectionFor({
      view,
      cfFeature: cfFeature ?? null,
      routerTopic: routerTopic ?? null,
      civitaiUserId,
      canView: true,
      readOnly: true,
    }),
};

/**
 * One panel's section: absent when it does not apply or the viewer holds none of its grants, `unlinked`
 * for a ticket with no user, and `unavailable` when its read throws, so a failing panel never fails the
 * ticket.
 */
async function sectionFor<K extends PanelKey>(
  key: K,
  ticket: PanelContext,
  canRead: CanRead,
  loaders: Loaders
): Promise<PanelSections[K] | undefined> {
  const spec = PANELS[key];
  if (!spec.readGrants.some(canRead)) return undefined;
  const visibility = spec.visibility(ticket);
  if (visibility === 'hidden') return undefined;
  if (visibility === 'unlinked' || ticket.civitaiUserId === null)
    return { status: 'unlinked' } as PanelSections[K];
  const userId = ticket.civitaiUserId;
  try {
    return await loaders[key]({ ...ticket, civitaiUserId: userId }, canRead);
  } catch (e) {
    console.error(`[tickets] ${key} panel failed`, e);
    return { status: 'unavailable', userId } as PanelSections[K];
  }
}

/** The payload sections for a ticket; a key is left out when its panel does not show. */
export async function loadPanels(
  ticket: PanelContext,
  canRead: CanRead,
  loaders: Loaders = liveLoaders
): Promise<Partial<PanelSections>> {
  const keys = Object.keys(PANELS) as PanelKey[];
  const sections = await Promise.all(keys.map((key) => sectionFor(key, ticket, canRead, loaders)));
  return Object.fromEntries(
    keys.flatMap((key, i) => (sections[i] ? [[key, sections[i]]] : []))
  ) as Partial<PanelSections>;
}
