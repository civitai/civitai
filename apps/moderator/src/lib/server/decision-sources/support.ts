import { getClickhouse } from '../clickhouse';
import { clickhouseDate } from '../clickhouse-date';
import { freshdeskTicketUrl, isFreshdeskId } from '../freshdesk.service';
import type { Decision } from '../../decisions';

/**
 * The support-ticket router as a `/decisions` source — READ-ONLY.
 *
 * 🔴 THE ONLY MODULE IN THIS APP THAT TOUCHES THE ROUTER'S TABLES, AND IT NEVER WRITES THEM. The
 * router is the single writer to its catalog, and the catalog decides what its model is asked next
 * run: a second writer here would change a live model's option set and could be silently undone by
 * the router's own re-inserts. Read-only access is enforced in this module rather than assumed from
 * the database, structurally:
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

/**
 * The router's own hard ceiling on active groups — at it, a routing run aborts by design.
 *
 * 🔴 A COPY, NOT A READ: this mirrors the router's `MAX_ACTIVE_GROUPS` setting, which this app cannot
 * see. Change both together — a stale copy misstates the header's cap and truncates the "Duplicate of"
 * picker, which is bounded by this same constant.
 */
export const ROUTER_CATALOG_CAP = 240;
/** Warn at 90% of the cap, while there is still room to act. Derived, so a cap change moves it too. */
export const CATALOG_WARN_AT = Math.floor(ROUTER_CATALOG_CAP * 0.9);
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
  // 🔴 SIZES ARE COUNTED HERE, SCOPED TO THE VERSION — NOT read from the router's
  // `support_issue_open_state` view. That view is deliberately version-agnostic: it keeps each
  // ticket's newest assignment across ALL versions, so a ticket re-routed under a newer version drops
  // out of its older group's count, and a page pinned to the older version would show a group smaller
  // than its own member list. `low_conf_members` mirrors the view's definition (p_novel > 0.4) so the
  // two agree whenever only one version is routing.
  list: `
    SELECT g.group_key AS group_key, g.title AS title, g.topic AS topic,
           g.founded_ticket_id AS founded_ticket_id, g.founded_at AS founded_at,
           g.created_by AS created_by,
           ifNull(d.n_members, 0) AS n_members,
           if(ifNull(d.n_members, 0) = 0, g.founded_at, d.last_seen) AS last_seen,
           ifNull(d.low_conf_members, 0) AS low_conf_members,
           ifNull(d.new_24h, 0) AS new_24h, ifNull(d.n_topics, 0) AS n_topics,
           r.ticket_subject AS rep_subject
    FROM (SELECT group_key, title, topic, founded_ticket_id, founded_at, created_by
          FROM support_issue_groups FINAL
          WHERE router_version = {v:String} AND stale = 0 AND closed_at IS NULL
            AND ({topic:String} = '' OR topic = {topic:String})) AS g
    LEFT JOIN (SELECT group_key,
                      count()                                         AS n_members,
                      max(ticket_created_at)                          AS last_seen,
                      countIf(p_novel > 0.4)                          AS low_conf_members,
                      countIf(assigned_at > now() - INTERVAL 24 HOUR) AS new_24h,
                      uniqExact(chosen_topic)                         AS n_topics
               FROM support_issue_group_members FINAL
               WHERE router_version = {v:String} AND group_key != ''
               GROUP BY group_key) AS d ON d.group_key = g.group_key
    LEFT JOIN (SELECT ticket_id, ticket_subject FROM support_tickets_routed FINAL
               WHERE router_version = {v:String}) AS r ON r.ticket_id = g.founded_ticket_id
    ORDER BY new_24h DESC, last_seen DESC
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
  // Bounded by the catalog cap, bound at the call site: while that copy matches the router, the
  // active catalog cannot exceed it, so the picker offers every candidate. A separate literal here
  // silently drops groups once the cap moves.
  duplicateTargets: `
    SELECT group_key, title, topic FROM support_issue_groups FINAL
    WHERE router_version = {v:String} AND closed_at IS NULL AND stale = 0
      AND group_key != {gk:String}
    ORDER BY (topic = {topic:String}) DESC, founded_at DESC
    LIMIT {limit:UInt32}`,
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
/** A topic slug, which doubles as an area until an area taxonomy exists. */
export const isAreaSlug = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-z0-9_-]{1,64}$/.test(v);
export const isTicketId = isFreshdeskId;

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
  now = Date.now(),
  /** A version pinned by `?version=` is usually a retired one, whose quiet is expected, not a fault. */
  pinned = false,
  /** Admins also see the router's own data-quality notes, which no moderator can act on. */
  admin = false
): string[] {
  const out: string[] = [];
  if (h.activeGroups >= CATALOG_WARN_AT)
    out.push(
      `The catalog holds ${h.activeGroups} of ${ROUTER_CATALOG_CAP} active groups. At the cap the ` +
        'router stops routing, and nothing retires groups automatically.'
    );
  // Engineer-facing: two specs under one version is expected while a spec change rolls out.
  if (admin && h.specCount > 1)
    out.push(
      `${h.specCount} different question specs answered under this one router version, so its ` +
        'answers mix questions that were worded differently.'
    );
  if (h.lastRoutedAt === null) out.push('No ticket has been routed under this version yet.');
  else if (!pinned && now - Date.parse(h.lastRoutedAt) > STALE_ROUTING_MINUTES * 60_000)
    out.push(
      `No ticket routed for over ${STALE_ROUTING_MINUTES} minutes — a quiet queue, or the router ` +
        'has stopped.'
    );
  return out;
}

export async function getSupportHeader(
  version: string,
  opts: { pinned?: boolean; now?: number; admin?: boolean } = {},
  client = reader()
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
  return {
    version,
    cap: ROUTER_CATALOG_CAP,
    ...base,
    warnings: headerWarnings(
      base,
      opts.now ?? Date.now(),
      opts.pinned ?? false,
      opts.admin ?? false
    ),
  };
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
  /**
   * The founding ticket's member row, or `null` when the founder has been re-routed out.
   *
   * 🔴 NOT `decision.lead`. The lead falls back to the oldest member so the decision always has a
   * face, but the page's "Founder" line names the FOUNDER — rendering a fallback member's
   * user, tier and badges next to the founder's ticket number would attribute one customer's details
   * to another's ticket.
   */
  representative: SupportMember | null;
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
  const representative = members.find((m) => m.isFounder) ?? null;
  return {
    group,
    representative,
    // The representative is the founder by the router's construction — not whoever sorts first.
    decision:
      members.length === 0
        ? null
        : {
            id: `support:${group.groupKey}`,
            groupKey: group.groupKey,
            members,
            lead: representative ?? members[0],
          },
    founder,
    topicsSpanned: [...new Set(members.map((m) => m.chosenTopic).filter(Boolean))].sort(),
    specHashes: [
      ...new Set(members.map((m) => m.questionSpecHash).filter((h): h is string => !!h)),
    ].sort(),
  };
}

/**
 * The ticket's member row in this group, or `null` when it is not a CURRENT member — the router may
 * have re-routed it since a page loaded. The one membership test for anything acting on a member.
 */
export const groupMember = (d: SupportGroupDetail, ticketId: string): SupportMember | null =>
  d.decision?.members.find((m) => m.ticketId === ticketId) ?? null;

export async function listDuplicateTargets(
  input: { version: string; groupKey: string; topic: string },
  client = reader()
): Promise<{ groupKey: string; title: string; topic: string }[]> {
  const out = await rows<{ group_key: string; title: string; topic: string }>(
    client,
    SUPPORT_SQL.duplicateTargets,
    { v: input.version, gk: input.groupKey, topic: input.topic, limit: ROUTER_CATALOG_CAP }
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
