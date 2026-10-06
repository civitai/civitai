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
  resolutionStoreStatus,
  type ResolutionStoreStatus,
} from '$lib/server/decision-resolution.service';
import { DEFAULT_STATE, STATE_FILTERS, buildInbox, groupRulingsByItem } from './inbox';

const querySchema = z.object({
  // One source today. In the URL already so a second source is a new enum value, not a new URL shape.
  source: z.enum(['support']).catch('support'),
  topic: z
    .string()
    .regex(/^[a-z0-9-]{0,64}$/)
    .catch(''),
  state: z.enum(STATE_FILTERS).catch(DEFAULT_STATE),
  page: z.coerce.number().int().min(1).catch(1),
});

export const load: PageServerLoad = async ({ url }) => {
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
        getSupportHeader(v),
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
      storeStatus: 'ok' as ResolutionStoreStatus,
      stateApplied: false,
    };
  }

  let storeStatus: ResolutionStoreStatus = 'ok';
  let rulings: ReturnType<typeof groupRulingsByItem> | null = null;
  if (version) {
    try {
      rulings = groupRulingsByItem(
        await currentResolutions({
          source: 'support-ticket',
          sourceVersion: version,
          itemKeys: items.map((r) => r.groupKey),
        })
      );
    } catch (e) {
      console.error('[decisions] resolution store read failed', e);
      storeStatus = resolutionStoreStatus(e);
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
