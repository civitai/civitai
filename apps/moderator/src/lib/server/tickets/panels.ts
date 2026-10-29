import { PANELS, type PanelContext, type PanelKey } from '$lib/tickets/panels';
import { accountSectionFor, type TicketAccount } from './account';
import { appealsSectionFor, type TicketAppeals } from './appeals';

export type PanelSections = {
  account: TicketAccount;
  appeals: TicketAppeals;
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
  account: ({ view, cfFeature, routerTopic, civitaiUserId }) =>
    accountSectionFor({ view, cfFeature, routerTopic, civitaiUserId, canView: true }),
  appeals: (ticket, canRead) =>
    appealsSectionFor({ userId: ticket.civitaiUserId, text: ticket.text ?? '', canRead }),
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
  const [account, appeals] = await Promise.all([
    sectionFor('account', ticket, canRead, loaders),
    sectionFor('appeals', ticket, canRead, loaders),
  ]);
  return { ...(account ? { account } : {}), ...(appeals ? { appeals } : {}) };
}
