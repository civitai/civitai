import { getClickhouse } from '../clickhouse';
import { clickhouseDate } from '../clickhouse-date';
import { freshdeskTicketUrl } from '../freshdesk.service';
import type { Decision } from '../../decisions';

/**
 * The support-ticket router as a `/decisions` source — READ-ONLY.
 *
 * 🔴 THE ONLY MODULE IN THIS APP THAT TOUCHES THE ROUTER'S TABLES, AND IT NEVER WRITES THEM. The
 * router is the single writer to its catalog, and the catalog decides what its model is asked next
 * run: a second writer here would change a live model's option set and could be silently undone by
 * the router's own re-inserts. Nothing in the database enforces this — the app's ClickHouse login can
 * read these tables and nothing has shown it cannot write them — so it is enforced here, structurally:
 *
 *   - every statement is a constant in `SUPPORT_SQL` (or built by `ticketSql`), so the full set is
 *     enumerable, and `decision-sources/__tests__/support.sql.test.ts` asserts each is a SELECT/WITH;
 *   - the client is held as `ClickhouseReader`, which exposes `query` and nothing else;
 *   - every value from a URL or form travels as a `{name:Type}` query parameter. Never the client's
 *     `$query` template helper: it inlines a string value UNQUOTED, so a group key would be raw SQL.
 *
 * 🔴 EVERY READ OF A ROUTER TABLE USES `FINAL`. They are ReplacingMergeTree: a re-routed ticket or a
 * re-founded group is a re-INSERT that collapses only at merge time, so without `FINAL` every count
 * and every member list includes the superseded rows. Nothing else in this app reads such a table, so
 * nothing else here shows the pattern — the SQL test fails any router-table reference without it.
 */

/** The narrowest client this module needs. Holding the full client would make a write one typo away. */
export type ClickhouseReader = {
  query(args: {
    query: string;
    query_params: Record<string, unknown>;
    format: 'JSONEachRow';
  }): Promise<{ json<T>(): Promise<T[]> }>;
};

const reader = (): ClickhouseReader => getClickhouse();

/** The router's own hard ceiling on active groups — at it, a routing run aborts by design. */
export const ROUTER_CATALOG_CAP = 200;
/** Warn this far below the cap, while there is still room to act. */
export const CATALOG_WARN_AT = 180;
/** No routed ticket for this long is worth a look — a quiet queue, or a stopped router. */
export const STALE_ROUTING_MINUTES = 45;
/** Group sizes at or above this in 24h are the router's own "misgroup or storm" alarm level. */
export const NEW_24H_ALARM = 10;
/** The inbox reads the whole active catalog and pages in memory; see `listSupportGroups`. */
export const LIST_CEILING = 1000;

/** Columns a member row reads from the routed table. `requester_email` and `body_excerpt` are NOT
 *  here: the member table never shows them, so it never selects them. */
const ROUTED_MEMBER_COLUMNS = `ticket_id, ticket_id AS routed_ticket_id, ticket_subject, ticket_status,
           member_tier, is_paying_priority, is_novel, civitai_user_id, question_spec_hash`;

export const SUPPORT_SQL = {
  latestVersion: `
    SELECT router_version FROM support_tickets_routed FINAL
    GROUP BY router_version ORDER BY max(ingested_at) DESC LIMIT 1`,
  // A version that has only been SEEDED has groups and no routed rows yet.
  latestSeededVersion: `
    SELECT router_version FROM support_issue_groups FINAL
    GROUP BY router_version ORDER BY max(updated_at) DESC LIMIT 1`,
  header: `
    SELECT
      (SELECT count() FROM support_issue_groups FINAL
         WHERE router_version = {v:String} AND stale = 0 AND closed_at IS NULL)  AS active_groups,
      (SELECT count() FROM support_tickets_routed FINAL
         WHERE router_version = {v:String})                                     AS n_routed,
      (SELECT max(ingested_at) FROM support_tickets_routed FINAL
         WHERE router_version = {v:String})                                     AS last_routed,
      (SELECT uniqExact(question_spec_hash) FROM support_tickets_routed FINAL
         WHERE router_version = {v:String})                                     AS n_specs`,
  topics: `
    SELECT topic, count() AS n FROM support_issue_groups FINAL
    WHERE router_version = {v:String} AND stale = 0 AND closed_at IS NULL
    GROUP BY topic ORDER BY topic`,
  // Sizes and low-confidence counts come from the router's own view, so the inbox and the router
  // agree on one definition. The view is version-agnostic; the INNER JOIN on this version's groups
  // is what scopes it (group keys hash the version).
  list: `
    SELECT o.group_key AS group_key, o.title AS title, o.topic AS topic,
           o.founded_ticket_id AS founded_ticket_id, o.founded_at AS founded_at,
           o.n_members AS n_members, o.last_seen AS last_seen,
           o.low_conf_members AS low_conf_members,
           g.created_by AS created_by,
           ifNull(d.new_24h, 0) AS new_24h, ifNull(d.n_topics, 0) AS n_topics,
           r.ticket_subject AS rep_subject
    FROM support_issue_open_state AS o
    INNER JOIN (SELECT group_key, created_by FROM support_issue_groups FINAL
                WHERE router_version = {v:String}) AS g ON g.group_key = o.group_key
    LEFT JOIN (SELECT group_key,
                      countIf(assigned_at > now() - INTERVAL 24 HOUR) AS new_24h,
                      uniqExact(chosen_topic)                         AS n_topics
               FROM support_issue_group_members FINAL
               WHERE router_version = {v:String} AND group_key != ''
               GROUP BY group_key) AS d ON d.group_key = o.group_key
    LEFT JOIN (SELECT ticket_id, ticket_subject FROM support_tickets_routed FINAL
               WHERE router_version = {v:String}) AS r ON r.ticket_id = o.founded_ticket_id
    WHERE o.is_active = 1 AND ({topic:String} = '' OR o.topic = {topic:String})
    ORDER BY new_24h DESC, o.last_seen DESC
    LIMIT {limit:UInt32}`,
  group: `
    SELECT group_key, title, gist, topic, issue_type, founded_ticket_id, founded_at, closed_at,
           stale, created_by, updated_at
    FROM support_issue_groups FINAL
    WHERE router_version = {v:String} AND group_key = {gk:String}`,
  // Oldest first, so the founder is row 1 by construction — and NOT re-sorted when it is not, because
  // that is the router's ordering invariant breaking and the page must say so.
  members: `
    SELECT m.ticket_id AS ticket_id, m.ticket_created_at AS ticket_created_at,
           m.p_group AS p_group, m.p_novel AS p_novel, m.p_topic AS p_topic,
           m.chosen_topic AS chosen_topic, m.assigned_at AS assigned_at,
           r.routed_ticket_id AS routed_ticket_id, r.ticket_subject AS ticket_subject,
           r.ticket_status AS ticket_status, r.member_tier AS member_tier,
           r.is_paying_priority AS is_paying_priority, r.is_novel AS is_novel,
           r.civitai_user_id AS civitai_user_id, r.question_spec_hash AS question_spec_hash
    FROM support_issue_group_members AS m FINAL
    LEFT JOIN (SELECT ${ROUTED_MEMBER_COLUMNS} FROM support_tickets_routed FINAL
               WHERE router_version = {v:String}) AS r USING (ticket_id)
    WHERE m.router_version = {v:String} AND m.group_key = {gk:String}
    ORDER BY m.ticket_created_at ASC, m.ticket_id ASC`,
  // On a novel verdict the routed row's `group_key` is '' — the group the ticket FOUNDED is on its
  // member row, so the ticket's current group is always read from here.
  membership: `
    SELECT m.group_key AS group_key, m.p_group AS p_group, m.p_novel AS p_novel,
           m.p_topic AS p_topic, m.chosen_topic AS chosen_topic, m.assigned_at AS assigned_at,
           g.title AS title, g.created_by AS created_by, g.founded_ticket_id AS founded_ticket_id
    FROM support_issue_group_members AS m FINAL
    LEFT JOIN (SELECT group_key, title, created_by, founded_ticket_id FROM support_issue_groups FINAL
               WHERE router_version = {v:String}) AS g USING (group_key)
    WHERE m.router_version = {v:String} AND m.ticket_id = {tid:String}`,
  duplicateTargets: `
    SELECT group_key, title, topic FROM support_issue_groups FINAL
    WHERE router_version = {v:String} AND closed_at IS NULL AND stale = 0
      AND group_key != {gk:String}
    ORDER BY (topic = {topic:String}) DESC, founded_at DESC
    LIMIT 200`,
} as const;

const TICKET_COLUMNS = `ticket_id, ticket_created_at, ticket_updated_at, ticket_status, ticket_subject,
           civitai_user_id, member_tier, is_paying_priority, body_excerpt,
           chosen_topic, p_topic, group_key, p_group, p_novel, is_novel,
           usage_input_tokens, usage_cost_micro_usd, latency_ms, router_version,
           question_spec_hash, model, ingested_at`;

/**
 * The ticket read, with or without the requester's email.
 *
 * 🔴 THE EMAIL IS NOT FETCHED AND HIDDEN — IT IS NOT FETCHED. Without the PII grant the column is
 * absent from the statement, so no code path (a log line, a serialised `load` payload, a future
 * component) can leak a value that never left the database.
 */
export const ticketSql = (includeEmail: boolean): string => `
    SELECT ${TICKET_COLUMNS}${includeEmail ? ', requester_email' : ''}
    FROM support_tickets_routed FINAL
    WHERE router_version = {v:String} AND ticket_id = {tid:String}`;

/** Every statement this module can issue — the set the SQL guard tests enumerate. */
export const ALL_SUPPORT_SQL: readonly string[] = [
  ...Object.values(SUPPORT_SQL),
  ticketSql(false),
  ticketSql(true),
];

async function rows<T>(
  client: ClickhouseReader,
  query: string,
  query_params: Record<string, unknown>
): Promise<T[]> {
  const res = await client.query({ query, query_params, format: 'JSONEachRow' });
  return res.json<T>();
}

// ---------------------------------------------------------------------------------------------
// Pure mappers — exported for their tests.
// ---------------------------------------------------------------------------------------------

/** `created_by` values whose FOUNDING member was never put to the model. */
const NO_MODEL_CALL = { seed: 'all', router_no_candidates: 'group' } as const;

/**
 * Which of a member's three probabilities are ABSENT rather than measured.
 *
 * 🔴 0.0 IS NOT ZERO CONFIDENCE HERE. A seeded group's founder was never routed (all three are 0.0),
 * and a `router_no_candidates` group's founder was routed with the group question skipped (`p_group`
 * and `p_novel` are 0.0; `p_topic` is real). Rendered as "0%" they read as a confident vendor answer
 * that was never given. The router documents that the values alone cannot identify this — a real
 * answer can also read 0.00 — so the branch is on `created_by` and founder-ness.
 *
 * The zero check is only the re-route guard: a founder the router later re-routes gets real values
 * written over its member row, and those must render.
 */
export function absentProbabilities(m: {
  createdBy: string;
  isFounder: boolean;
  pGroup: number;
  pNovel: number;
}): { topic: boolean; groupAndNovel: boolean } {
  const kind = NO_MODEL_CALL[m.createdBy as keyof typeof NO_MODEL_CALL];
  if (!kind || !m.isFounder || m.pGroup !== 0 || m.pNovel !== 0)
    return { topic: false, groupAndNovel: false };
  return { topic: kind === 'all', groupAndNovel: true };
}

/** A probability, or `null` when it was never measured. Never a fabricated 0. */
export type Probabilities = { topic: number | null; group: number | null; novel: number | null };

export function probabilities(m: {
  createdBy: string;
  isFounder: boolean;
  pTopic: number;
  pGroup: number;
  pNovel: number;
}): Probabilities {
  const pTopic = Number(m.pTopic);
  const pGroup = Number(m.pGroup);
  const pNovel = Number(m.pNovel);
  const absent = absentProbabilities({ ...m, pGroup, pNovel });
  return {
    topic: absent.topic ? null : pTopic,
    group: absent.groupAndNovel ? null : pGroup,
    novel: absent.groupAndNovel ? null : pNovel,
  };
}

/** A ClickHouse `DateTime`/`DateTime64` string as ISO, or `null` for a NULL/empty column. */
export const chDate = (value: string | null | undefined): string | null =>
  value ? clickhouseDate(value) : null;

/**
 * Where the founding ticket sits in the oldest-first member list.
 *
 * `not-first` is the router's ordering invariant breaking (a backfill ran newest-first), which makes
 * the group's representative wrong. `absent` is the founder having been re-routed into another group,
 * which is a different and legitimate state — the two must not share a warning.
 */
export type FounderPosition = 'first' | 'not-first' | 'absent';

export function founderPosition(
  memberTicketIds: readonly string[],
  foundedTicketId: string
): FounderPosition {
  if (memberTicketIds[0] === foundedTicketId) return 'first';
  return memberTicketIds.includes(foundedTicketId) ? 'not-first' : 'absent';
}

/** `?version=` wins when it is given; otherwise the version that routed most recently. */
export function resolveVersion(
  override: string | null | undefined,
  fromData: string | null
): { version: string | null; overridden: boolean } {
  if (override) return { version: override, overridden: true };
  return { version: fromData, overridden: false };
}

/** URL inputs. They reach SQL only as bound parameters; these bound their shape so a malformed one is
 *  a 404 rather than a query. */
export const isRouterVersion = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v);
export const isGroupKey = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
export const isTicketId = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{1,20}$/.test(v);

// ---------------------------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------------------------

export async function latestRouterVersion(client = reader()): Promise<string | null> {
  const routed = await rows<{ router_version: string }>(client, SUPPORT_SQL.latestVersion, {});
  if (routed[0]?.router_version) return routed[0].router_version;
  const seeded = await rows<{ router_version: string }>(
    client,
    SUPPORT_SQL.latestSeededVersion,
    {}
  );
  return seeded[0]?.router_version ?? null;
}

/**
 * The version a page shows: `?version=` when valid, else the one that routed most recently.
 * 🔴 Resolved from data on every load, never a constant — a router version bump must not leave this
 * page reading a version nobody writes any more.
 */
export async function supportVersion(
  rawOverride: string | null,
  client = reader()
): Promise<{ version: string | null; overridden: boolean }> {
  const override = isRouterVersion(rawOverride) ? rawOverride : null;
  return resolveVersion(override, override ? null : await latestRouterVersion(client));
}

export type SupportHeader = {
  version: string;
  activeGroups: number;
  cap: number;
  lastRoutedAt: string | null;
  specCount: number;
  warnings: string[];
};

export function headerWarnings(
  h: Omit<SupportHeader, 'warnings' | 'version' | 'cap'>,
  now = Date.now()
): string[] {
  const out: string[] = [];
  if (h.activeGroups >= CATALOG_WARN_AT)
    out.push(
      `The catalog holds ${h.activeGroups} of ${ROUTER_CATALOG_CAP} active groups. At the cap the ` +
        'router stops routing, and nothing retires groups automatically.'
    );
  if (h.specCount > 1)
    out.push(
      `${h.specCount} different question specs answered under this one router version, so its ` +
        'answers mix questions that were worded differently.'
    );
  if (h.lastRoutedAt === null) out.push('No ticket has been routed under this version yet.');
  else if (now - Date.parse(h.lastRoutedAt) > STALE_ROUTING_MINUTES * 60_000)
    out.push(
      `No ticket routed for over ${STALE_ROUTING_MINUTES} minutes — a quiet queue, or the router ` +
        'has stopped.'
    );
  return out;
}

export async function getSupportHeader(
  version: string,
  client = reader(),
  now = Date.now()
): Promise<SupportHeader> {
  const [r] = await rows<{
    active_groups: number | string;
    n_routed: number | string;
    last_routed: string;
    n_specs: number | string;
  }>(client, SUPPORT_SQL.header, { v: version });
  const base = {
    activeGroups: Number(r?.active_groups ?? 0),
    // `max()` over no rows is the epoch, not NULL — the routed count is what says "none".
    lastRoutedAt: Number(r?.n_routed ?? 0) > 0 ? chDate(r?.last_routed) : null,
    specCount: Number(r?.n_specs ?? 0),
  };
  return { version, cap: ROUTER_CATALOG_CAP, ...base, warnings: headerWarnings(base, now) };
}

export async function listSupportTopics(
  version: string,
  client = reader()
): Promise<{ topic: string; groups: number }[]> {
  const out = await rows<{ topic: string; n: number | string }>(client, SUPPORT_SQL.topics, {
    v: version,
  });
  return out.map((r) => ({ topic: r.topic, groups: Number(r.n) }));
}

export type SupportGroupListRow = {
  groupKey: string;
  title: string;
  topic: string;
  createdBy: string;
  foundedTicketId: string;
  foundedAt: string | null;
  members: number;
  new24h: number;
  /** At the router's own misgroup/storm alarm level. */
  new24hAlarm: boolean;
  topicCount: number;
  lowConfidence: number;
  lastSeen: string | null;
  ticketUrl: string;
};

type ListRowRaw = {
  group_key: string;
  title: string;
  topic: string;
  founded_ticket_id: string;
  founded_at: string;
  n_members: number | string;
  last_seen: string;
  low_conf_members: number | string;
  created_by: string;
  new_24h: number | string;
  n_topics: number | string;
  rep_subject: string;
};

export function mapListRow(r: ListRowRaw): SupportGroupListRow {
  return {
    groupKey: r.group_key,
    // A seeded founder has no routed row, so its subject comes from the group's own title.
    title: r.rep_subject || r.title,
    topic: r.topic,
    createdBy: r.created_by,
    foundedTicketId: r.founded_ticket_id,
    foundedAt: chDate(r.founded_at),
    members: Number(r.n_members),
    new24h: Number(r.new_24h),
    new24hAlarm: Number(r.new_24h) >= NEW_24H_ALARM,
    topicCount: Number(r.n_topics),
    lowConfidence: Number(r.low_conf_members),
    lastSeen: chDate(r.last_seen),
    ticketUrl: freshdeskTicketUrl(r.founded_ticket_id),
  };
}

/**
 * Every active group of the version, in the router's size-delta order.
 *
 * Read whole and paged by the caller: the ruling state a moderator filters on lives in Postgres, which
 * ClickHouse cannot join, so a ClickHouse `OFFSET` would page BEFORE the filter and drop rows. The
 * router caps its active catalog at `ROUTER_CATALOG_CAP`, so the whole list is small; `truncated`
 * says so if that ever stops being true.
 */
export async function listSupportGroups(
  input: { version: string; topic: string },
  client = reader()
): Promise<{ rows: SupportGroupListRow[]; truncated: boolean }> {
  const out = await rows<ListRowRaw>(client, SUPPORT_SQL.list, {
    v: input.version,
    topic: input.topic,
    limit: LIST_CEILING + 1,
  });
  return {
    rows: out.slice(0, LIST_CEILING).map(mapListRow),
    truncated: out.length > LIST_CEILING,
  };
}

export type SupportMember = {
  ticketId: string;
  ticketCreatedAt: string | null;
  assignedAt: string | null;
  chosenTopic: string;
  probabilities: Probabilities;
  isFounder: boolean;
  /** False for a seeded founder — it was never routed, so the fields below are unknown. */
  routed: boolean;
  subject: string | null;
  status: string | null;
  memberTier: string | null;
  payingPriority: boolean;
  isNovel: boolean;
  civitaiUserId: string | null;
  questionSpecHash: string | null;
  ticketUrl: string;
};

type MemberRaw = {
  ticket_id: string;
  ticket_created_at: string;
  p_group: number;
  p_novel: number;
  p_topic: number;
  chosen_topic: string;
  assigned_at: string;
  routed_ticket_id: string;
  ticket_subject: string;
  ticket_status: string;
  member_tier: string;
  is_paying_priority: number;
  is_novel: number;
  civitai_user_id: string | null;
  question_spec_hash: string;
};

export function mapMember(r: MemberRaw, group: { createdBy: string; foundedTicketId: string }) {
  const isFounder = r.ticket_id === group.foundedTicketId;
  // A LEFT JOIN miss fills ClickHouse defaults (''/0), not NULL — `routed_ticket_id` is what tells
  // "never routed" apart from "routed with an empty field".
  const routed = !!r.routed_ticket_id;
  return {
    ticketId: r.ticket_id,
    ticketCreatedAt: chDate(r.ticket_created_at),
    assignedAt: chDate(r.assigned_at),
    chosenTopic: r.chosen_topic,
    probabilities: probabilities({
      createdBy: group.createdBy,
      isFounder,
      pTopic: r.p_topic,
      pGroup: r.p_group,
      pNovel: r.p_novel,
    }),
    isFounder,
    routed,
    subject: routed ? r.ticket_subject : null,
    status: routed ? r.ticket_status : null,
    memberTier: routed ? r.member_tier || null : null,
    payingPriority: routed && Number(r.is_paying_priority) === 1,
    isNovel: routed && Number(r.is_novel) === 1,
    civitaiUserId: routed ? r.civitai_user_id || null : null,
    questionSpecHash: routed ? r.question_spec_hash || null : null,
    ticketUrl: freshdeskTicketUrl(r.ticket_id),
  } satisfies SupportMember;
}

export type SupportGroup = {
  groupKey: string;
  title: string;
  gist: string;
  topic: string;
  issueType: string;
  createdBy: string;
  foundedTicketId: string;
  foundedAt: string | null;
  closedAt: string | null;
  stale: boolean;
  updatedAt: string | null;
  ticketUrl: string;
};

type GroupRaw = {
  group_key: string;
  title: string;
  gist: string;
  topic: string;
  issue_type: string;
  founded_ticket_id: string;
  founded_at: string;
  closed_at: string | null;
  stale: number;
  created_by: string;
  updated_at: string;
};

const mapGroup = (g: GroupRaw): SupportGroup => ({
  groupKey: g.group_key,
  title: g.title,
  gist: g.gist,
  topic: g.topic,
  issueType: g.issue_type,
  createdBy: g.created_by,
  foundedTicketId: g.founded_ticket_id,
  foundedAt: chDate(g.founded_at),
  closedAt: chDate(g.closed_at),
  stale: Number(g.stale) === 1,
  updatedAt: chDate(g.updated_at),
  ticketUrl: freshdeskTicketUrl(g.founded_ticket_id),
});

export type SupportGroupDetail = {
  group: SupportGroup;
  decision: Decision<SupportMember> | null;
  founder: FounderPosition;
  topicsSpanned: string[];
  specHashes: string[];
};

/** One group and its members, or `null` when the version has no such group (a 404, not an empty group). */
export async function getSupportGroup(
  input: { version: string; groupKey: string },
  client = reader()
): Promise<SupportGroupDetail | null> {
  const params = { v: input.version, gk: input.groupKey };
  const [groups, memberRows] = await Promise.all([
    rows<GroupRaw>(client, SUPPORT_SQL.group, params),
    rows<MemberRaw>(client, SUPPORT_SQL.members, params),
  ]);
  if (groups.length === 0) return null;
  const group = mapGroup(groups[0]);
  const members = memberRows.map((r) => mapMember(r, group));
  const founder = founderPosition(
    members.map((m) => m.ticketId),
    group.foundedTicketId
  );
  return {
    group,
    // The representative is the founder by the router's construction — not whoever sorts first.
    decision:
      members.length === 0
        ? null
        : {
            id: `support:${group.groupKey}`,
            groupKey: group.groupKey,
            members,
            lead: members.find((m) => m.isFounder) ?? members[0],
          },
    founder,
    topicsSpanned: [...new Set(members.map((m) => m.chosenTopic).filter(Boolean))].sort(),
    specHashes: [
      ...new Set(members.map((m) => m.questionSpecHash).filter((h): h is string => !!h)),
    ].sort(),
  };
}

export async function listDuplicateTargets(
  input: { version: string; groupKey: string; topic: string },
  client = reader()
): Promise<{ groupKey: string; title: string; topic: string }[]> {
  const out = await rows<{ group_key: string; title: string; topic: string }>(
    client,
    SUPPORT_SQL.duplicateTargets,
    { v: input.version, gk: input.groupKey, topic: input.topic }
  );
  return out.map((r) => ({ groupKey: r.group_key, title: r.title, topic: r.topic }));
}

export type SupportTicket = {
  ticketId: string;
  createdAt: string | null;
  updatedAt: string | null;
  status: string;
  subject: string;
  civitaiUserId: string | null;
  memberTier: string | null;
  payingPriority: boolean;
  bodyExcerpt: string;
  chosenTopic: string;
  probabilities: Probabilities;
  isNovel: boolean;
  inputTokens: number;
  costMicroUsd: number;
  latencyMs: number;
  routerVersion: string;
  questionSpecHash: string;
  model: string;
  routedAt: string | null;
  /** Present ONLY when the caller holds the PII grant — see `ticketSql`. */
  requesterEmail?: string;
  ticketUrl: string;
  membership: {
    groupKey: string;
    title: string | null;
    createdBy: string | null;
    isFounder: boolean;
    assignedAt: string | null;
  } | null;
};

type TicketRaw = {
  ticket_id: string;
  ticket_created_at: string;
  ticket_updated_at: string;
  ticket_status: string;
  ticket_subject: string;
  civitai_user_id: string | null;
  member_tier: string;
  is_paying_priority: number;
  body_excerpt: string;
  chosen_topic: string;
  p_topic: number;
  group_key: string;
  p_group: number;
  p_novel: number;
  is_novel: number;
  usage_input_tokens: number | string;
  usage_cost_micro_usd: number | string;
  latency_ms: number | string;
  router_version: string;
  question_spec_hash: string;
  model: string;
  ingested_at: string;
  requester_email?: string;
};

type MembershipRaw = {
  group_key: string;
  title: string;
  created_by: string;
  founded_ticket_id: string;
  assigned_at: string;
};

export function mapTicket(
  t: TicketRaw,
  m: MembershipRaw | undefined,
  includeEmail: boolean
): SupportTicket {
  const isFounder = !!m && m.founded_ticket_id === t.ticket_id;
  const createdBy = m?.created_by || '';
  return {
    ticketId: t.ticket_id,
    createdAt: chDate(t.ticket_created_at),
    updatedAt: chDate(t.ticket_updated_at),
    status: t.ticket_status,
    subject: t.ticket_subject,
    civitaiUserId: t.civitai_user_id || null,
    memberTier: t.member_tier || null,
    payingPriority: Number(t.is_paying_priority) === 1,
    bodyExcerpt: t.body_excerpt,
    chosenTopic: t.chosen_topic,
    // A routed row was put to the model for its topic; only the group half can be absent.
    probabilities: probabilities({
      createdBy,
      isFounder,
      pTopic: t.p_topic,
      pGroup: t.p_group,
      pNovel: t.p_novel,
    }),
    isNovel: Number(t.is_novel) === 1,
    inputTokens: Number(t.usage_input_tokens),
    costMicroUsd: Number(t.usage_cost_micro_usd),
    latencyMs: Number(t.latency_ms),
    routerVersion: t.router_version,
    questionSpecHash: t.question_spec_hash,
    model: t.model,
    routedAt: chDate(t.ingested_at),
    ...(includeEmail ? { requesterEmail: t.requester_email ?? '' } : {}),
    ticketUrl: freshdeskTicketUrl(t.ticket_id),
    membership:
      m && m.group_key
        ? {
            groupKey: m.group_key,
            title: m.title || null,
            createdBy: m.created_by || null,
            isFounder,
            assignedAt: chDate(m.assigned_at),
          }
        : null,
  };
}

/** One routed ticket, or `null` when this version never routed it. */
export async function getSupportTicket(
  input: { version: string; ticketId: string; includeEmail: boolean },
  client = reader()
): Promise<SupportTicket | null> {
  const params = { v: input.version, tid: input.ticketId };
  const [tickets, membership] = await Promise.all([
    rows<TicketRaw>(client, ticketSql(input.includeEmail), params),
    rows<MembershipRaw>(client, SUPPORT_SQL.membership, params),
  ]);
  if (tickets.length === 0) return null;
  return mapTicket(tickets[0], membership[0], input.includeEmail);
}
