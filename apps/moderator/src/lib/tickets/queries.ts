import { LIVE_STATUSES } from './statuses';
import { TICKET_ROUTING } from './routing';

/** Freshdesk rejects a search expression longer than this. */
export const SEARCH_QUERY_MAX_CHARS = 512;

const anyOf = (terms: readonly string[]) => `(${terms.join(' OR ')})`;
const LIVE = anyOf(LIVE_STATUSES.map((s) => `status:${s}`));

/** Live tickets the routing rule sends to moderation without needing the router. */
export const moderationQuery = (): string =>
  `${anyOf([
    ...TICKET_ROUTING.moderationFeatures.map((f) => `cf_feature:'${f}'`),
    ...TICKET_ROUTING.moderationStatuses.map((s) => `status:${s}`),
  ])} AND ${LIVE}`;

/** Live tickets with no `cf_feature`: the ones the router's topic may move into moderation. */
export const unclassifiedQuery = (): string => `cf_feature:null AND ${LIVE}`;

/** One live status. Search returns at most 300 results per expression, so the support view, which has
 *  no narrower filter, reads one status at a time. */
export const statusQuery = (status: number): string => `status:${status}`;
