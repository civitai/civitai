import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import {
  getSupportHeader,
  listSupportGroups,
  listSupportTopics,
  supportVersion,
  type SupportGroupListRow,
  type SupportHeader,
} from '$lib/server/decision-sources/support';
import {
  currentResolutions,
  partitionResolutions,
  type GroupRulingSummary,
} from '$lib/server/decision-resolution.service';
import { moderatorDbStatus, type ModeratorDbStatus } from '$lib/moderator-db-status';
import { isAreaSlug } from '$lib/server/decision-sources/support';
import { isSuper } from '$lib/server/access';
import { DEFAULT_STATE, STATE_FILTERS, buildInbox } from './inbox';

const querySchema = z.object({
  // One source today. In the URL already so a second source is a new enum value, not a new URL shape.
  source: z.enum(['support']).catch('support'),
  topic: z
    .string()
    .refine((v) => v === '' || isAreaSlug(v))
    .catch(''),
  state: z.enum(STATE_FILTERS).catch(DEFAULT_STATE),
  page: z.coerce.number().int().min(1).catch(1),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  const { source, topic, state, page } = parseQuery(url, querySchema);
  const filters = { source, topic, state };

  // 🔴 THE TWO STORES FAIL INDEPENDENTLY, AND EACH SAYS WHICH. ClickHouse holds the items; Postgres
  // holds the rulings and is applied by hand, so for a while it will not exist at all. A missing
  // ruling table must still show every item (read-only); a ClickHouse failure has nothing to show.
  let header: SupportHeader | null = null;
  let topics: { topic: string; groups: number }[] = [];
  let items: SupportGroupListRow[] = [];
  let truncated = false;
  let version: string | null = null;
  let overridden = false;
  try {
    ({ version, overridden } = await supportVersion(url.searchParams.get('version')));
    if (version) {
      const v = version;
      [header, topics, { rows: items, truncated }] = await Promise.all([
        getSupportHeader(v, { pinned: overridden, admin: isSuper(locals.user) }),
        listSupportTopics(v),
        listSupportGroups({ version: v, topic }),
      ]);
    }
  } catch (e) {
    console.error('[decisions] support source failed', e);
    return {
      filters,
      sourceStatus: 'unreachable' as const,
      version,
      overridden,
      header: null,
      topics: [],
      rows: [],
      total: 0,
      page: 1,
      truncated: false,
      storeStatus: 'ok' as ModeratorDbStatus,
      stateApplied: false,
    };
  }

  let storeStatus: ModeratorDbStatus = 'ok';
  let rulings: Map<string, GroupRulingSummary> | null = null;
  if (version) {
    try {
      rulings = partitionResolutions(
        await currentResolutions({
          source: 'support-ticket',
          sourceVersion: version,
          itemKeys: items.map((r) => r.groupKey),
        })
      ).groups;
    } catch (e) {
      console.error('[decisions] resolution store read failed', e);
      storeStatus = moderatorDbStatus(e);
    }
  }

  const inbox = buildInbox(items, rulings, { state, page });
  return {
    filters,
    sourceStatus: version ? ('ok' as const) : ('empty' as const),
    version,
    overridden,
    header,
    topics,
    rows: inbox.rows,
    total: inbox.total,
    page: inbox.page,
    truncated,
    storeStatus,
    stateApplied: inbox.stateApplied,
  };
};
