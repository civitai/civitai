import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALL_SUPPORT_SQL,
  SUPPORT_SQL,
  getSupportGroup,
  getSupportHeader,
  getSupportTicket,
  latestRouterVersion,
  listDuplicateTargets,
  listSupportGroups,
  listSupportTopics,
  supportVersion,
  ticketSql,
  type ClickhouseReader,
} from '../support';

/**
 * 🔴 THE ROUTER'S TABLES ARE READ-ONLY TO THIS APP, AND THESE TESTS ARE THE ONLY THING ENFORCING IT.
 * The app's ClickHouse login can read them and nothing has shown it cannot write them, so "never
 * writes" is a property of this code alone. Each block below pins one half of it, with a control
 * proving the check can go red.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '../../../..');
const MODULE = join(HERE, '../support.ts');

const ROUTER_TABLES = [
  'support_tickets_routed',
  'support_issue_groups',
  'support_issue_group_members',
];
const ROUTER_OBJECTS = [...ROUTER_TABLES, 'support_issue_open_state'];

const WRITE_KEYWORDS =
  /\b(INSERT|ALTER|DROP|TRUNCATE|DELETE|CREATE|RENAME|OPTIMIZE|SYSTEM|GRANT|REVOKE|KILL|ATTACH|DETACH|EXCHANGE|UPDATE|REPLACE)\b/i;

/** Is the statement a single read? */
const isRead = (sql: string) =>
  /^\s*(SELECT|WITH)\b/i.test(sql) && !WRITE_KEYWORDS.test(sql) && !sql.includes(';');

/** Router-table references NOT followed by `FINAL` (optionally after an alias). */
const unfinalised = (sql: string): string[] =>
  [
    ...sql.matchAll(
      new RegExp(`\\b(${ROUTER_TABLES.join('|')})\\b(\\s+AS\\s+\\w+)?(\\s+FINAL\\b)?`, 'gi')
    ),
  ]
    .filter((m) => !m[3])
    .map((m) => m[0]);

const placeholders = (sql: string) => [...sql.matchAll(/\{(\w+):\w+\}/g)].map((m) => m[1]);

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('every statement the adapter can issue is a parameterised read', () => {
  it('enumerates a non-trivial set — positive control', () => {
    // An empty set makes every assertion below vacuously true.
    expect(ALL_SUPPORT_SQL.length).toBe(Object.keys(SUPPORT_SQL).length + 2);
    expect(ALL_SUPPORT_SQL.length).toBeGreaterThanOrEqual(10);
  });

  it('the read check can go red — negative control', () => {
    expect(isRead('INSERT INTO support_issue_groups (group_key) VALUES (1)')).toBe(false);
    expect(isRead('SELECT 1; DROP TABLE support_issue_groups')).toBe(false);
    expect(isRead('ALTER TABLE support_issue_groups UPDATE stale = 1 WHERE 1')).toBe(false);
    // …and does not trip on column names that merely contain a keyword.
    expect(isRead('SELECT created_by, updated_at FROM t')).toBe(true);
  });

  it.each(ALL_SUPPORT_SQL.map((s, i) => [i, s]))(
    'statement %i is a single SELECT/WITH',
    (_i, sql) => {
      expect(isRead(sql as string), sql as string).toBe(true);
    }
  );

  it('the FINAL check can go red — negative control', () => {
    expect(unfinalised('SELECT 1 FROM support_issue_groups WHERE x')).toEqual([
      'support_issue_groups',
    ]);
    expect(unfinalised('FROM support_issue_group_members AS m WHERE')).toHaveLength(1);
    expect(unfinalised('FROM support_issue_group_members AS m FINAL WHERE')).toEqual([]);
  });

  it.each(ALL_SUPPORT_SQL.map((s, i) => [i, s]))(
    'statement %i reads every router table with FINAL',
    (_i, sql) => {
      expect(unfinalised(sql as string), sql as string).toEqual([]);
    }
  );

  it('every statement touches at least one router object — the set is the router set', () => {
    for (const sql of ALL_SUPPORT_SQL)
      expect(
        ROUTER_OBJECTS.some((t) => sql.includes(t)),
        sql
      ).toBe(true);
  });
});

/** A client that records every call and refuses everything but `query`. */
function recordingClient(rowsFor: (sql: string) => unknown[] = () => []) {
  const calls: { query: string; query_params: Record<string, unknown>; format: string }[] = [];
  const forbidden = (name: string) => () => {
    throw new Error(`the adapter called ${name} on the ClickHouse client`);
  };
  const client = {
    query: async (args: {
      query: string;
      query_params: Record<string, unknown>;
      format: string;
    }) => {
      calls.push(args);
      return { json: async () => rowsFor(args.query) };
    },
    insert: forbidden('insert'),
    command: forbidden('command'),
    exec: forbidden('exec'),
    $query: forbidden('$query'),
    $exec: forbidden('$exec'),
  };
  return { client: client as unknown as ClickhouseReader, calls };
}

const HOSTILE = "g_x' OR 1=1 --";

async function exerciseEverything(client: ClickhouseReader) {
  await latestRouterVersion(client);
  await supportVersion(null, client);
  await getSupportHeader('v', {}, client);
  await listSupportTopics('v', client);
  await listSupportGroups({ version: 'v', topic: HOSTILE }, client);
  await getSupportGroup({ version: 'v', groupKey: HOSTILE }, client);
  await listDuplicateTargets({ version: 'v', groupKey: HOSTILE, topic: HOSTILE }, client);
  await getSupportTicket({ version: 'v', ticketId: HOSTILE, includeEmail: false }, client);
  await getSupportTicket({ version: 'v', ticketId: HOSTILE, includeEmail: true }, client);
}

describe('what the adapter actually sends', () => {
  it('issues only enumerated statements, only through query(), always JSONEachRow', async () => {
    const { client, calls } = recordingClient();
    await exerciseEverything(client);
    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const c of calls) {
      expect(ALL_SUPPORT_SQL, c.query).toContain(c.query);
      expect(c.format).toBe('JSONEachRow');
    }
  });

  it('binds every placeholder as a parameter; URL input never reaches the SQL text', async () => {
    const { client, calls } = recordingClient();
    await exerciseEverything(client);
    for (const c of calls) {
      for (const name of placeholders(c.query))
        expect(c.query_params, c.query).toHaveProperty(name);
      expect(c.query).not.toContain(HOSTILE);
    }
    expect(calls.some((c) => Object.values(c.query_params).includes(HOSTILE))).toBe(true);
  });

  it('the module source has no write method, no exec, and no `$query` template helper', () => {
    const src = stripComments(readFileSync(MODULE, 'utf8'));
    expect(src.length).toBeGreaterThan(2000);
    for (const banned of ['.insert(', '.command(', '.exec(', '$query', '$exec', 'createClient'])
      expect(src, banned).not.toContain(banned);
  });

  it('the source scan can go red — negative control', () => {
    const planted = stripComments(
      `const x = 1;\nclient.insert({ table: 'support_issue_groups' });`
    );
    expect(planted).toContain('.insert(');
    // And a banned word in a COMMENT does not trip it, which is why comments are stripped.
    expect(stripComments('// never use $query here')).not.toContain('$query');
  });
});

describe('each call binds the RIGHT value to each parameter', () => {
  it("pins every statement's parameters", async () => {
    const { client, calls } = recordingClient();
    await getSupportGroup({ version: 'v1', groupKey: 'g_a' }, client);
    await listSupportGroups({ version: 'v1', topic: 'crypto' }, client);
    await listDuplicateTargets({ version: 'v1', groupKey: 'g_a', topic: 'crypto' }, client);
    await getSupportTicket({ version: 'v1', ticketId: '42', includeEmail: false }, client);
    const params = (sql: string) => calls.filter((c) => c.query === sql).map((c) => c.query_params);
    expect(params(SUPPORT_SQL.group)).toEqual([{ v: 'v1', gk: 'g_a' }]);
    expect(params(SUPPORT_SQL.members)).toEqual([{ v: 'v1', gk: 'g_a' }]);
    expect(params(SUPPORT_SQL.list)).toEqual([{ v: 'v1', topic: 'crypto', limit: 1001 }]);
    // The picker is bounded by the router's catalog cap (240), so it can offer every active group.
    expect(params(SUPPORT_SQL.duplicateTargets)).toEqual([
      { v: 'v1', gk: 'g_a', topic: 'crypto', limit: 240 },
    ]);
    expect(params(ticketSql(false))).toEqual([{ v: 'v1', tid: '42' }]);
    expect(params(SUPPORT_SQL.membership)).toEqual([{ v: 'v1', tid: '42' }]);
  });

  it('the version is the latest by max(ingested_at) — the whole statement, normalised', () => {
    expect(SUPPORT_SQL.latestVersion.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT router_version FROM support_tickets_routed FINAL GROUP BY router_version ORDER BY max(ingested_at) DESC LIMIT 1'
    );
  });
});

describe('composition over real-shaped rows', () => {
  const groupRow = {
    group_key: 'g_a',
    title: 'T',
    gist: '',
    topic: 'crypto',
    issue_type: '',
    founded_ticket_id: '2',
    founded_at: '2026-10-01 00:00:00.000',
    closed_at: null,
    stale: 0,
    created_by: 'router',
    updated_at: '2026-10-01 00:00:00.000',
  };
  const memberRow = (id: string) => ({
    ticket_id: id,
    ticket_created_at: '2026-10-01 00:00:00.000',
    p_group: 0.5,
    p_novel: 0.1,
    p_topic: 0.9,
    chosen_topic: 'crypto',
    assigned_at: '2026-10-01 00:00:00.000',
    routed_ticket_id: id,
    ticket_subject: `s${id}`,
    ticket_status: 'open',
    member_tier: '',
    is_paying_priority: 0,
    is_novel: 0,
    civitai_user_id: null,
    question_spec_hash: 'h',
  });

  it('the lead and representative are the FOUNDER, even when an older member sorts first', async () => {
    const { client } = recordingClient((sql) =>
      sql === SUPPORT_SQL.group
        ? [groupRow]
        : sql === SUPPORT_SQL.members
        ? [memberRow('1'), memberRow('2')]
        : []
    );
    const d = await getSupportGroup({ version: 'v', groupKey: 'g_a' }, client);
    expect(d?.decision?.lead.ticketId).toBe('2');
    expect(d?.representative?.ticketId).toBe('2');
    expect(d?.founder).toBe('not-first');
  });

  it('a founder re-routed out leaves NO representative — never another member standing in', async () => {
    const { client } = recordingClient((sql) =>
      sql === SUPPORT_SQL.group ? [groupRow] : sql === SUPPORT_SQL.members ? [memberRow('3')] : []
    );
    const d = await getSupportGroup({ version: 'v', groupKey: 'g_a' }, client);
    expect(d?.representative).toBeNull();
    expect(d?.founder).toBe('absent');
    expect(d?.decision?.lead.ticketId).toBe('3');
  });

  it('a group with no members has no decision', async () => {
    const { client } = recordingClient((sql) => (sql === SUPPORT_SQL.group ? [groupRow] : []));
    expect((await getSupportGroup({ version: 'v', groupKey: 'g_a' }, client))?.decision).toBeNull();
  });

  it('header: nothing routed is "never routed", not an epoch timestamp read as "stopped"', async () => {
    const { client } = recordingClient(() => [
      { active_groups: 3, n_routed: 0, last_routed: '1970-01-01 00:00:00.000', n_specs: 0 },
    ]);
    const h = await getSupportHeader('v', {}, client);
    expect(h.lastRoutedAt).toBeNull();
    expect(h.warnings).toEqual(['No ticket has been routed under this version yet.']);
  });

  it('header: the question-spec note reaches the warnings for an admin only', async () => {
    const { client } = recordingClient(() => [
      { active_groups: 3, n_routed: 0, last_routed: '1970-01-01 00:00:00.000', n_specs: 2 },
    ]);
    const spec = /2 different question specs/;
    expect((await getSupportHeader('v', { admin: true }, client)).warnings[0]).toMatch(spec);
    expect((await getSupportHeader('v', {}, client)).warnings.join('\n')).not.toMatch(spec);
  });

  it("header: reports the router's catalog cap", async () => {
    const { client } = recordingClient(() => [
      { active_groups: 3, n_routed: 0, last_routed: '1970-01-01 00:00:00.000', n_specs: 0 },
    ]);
    expect((await getSupportHeader('v', {}, client)).cap).toBe(240);
  });
});

describe('PII — the requester email is selected only with the grant', () => {
  it('ticketSql(false) does not name the column; ticketSql(true) does', () => {
    expect(ticketSql(false)).not.toMatch(/requester_email/);
    expect(ticketSql(true)).toMatch(/requester_email/);
  });

  it('no other statement names it', () => {
    for (const sql of Object.values(SUPPORT_SQL)) expect(sql).not.toMatch(/requester_email/);
  });

  it('getSupportTicket without the grant sends a statement without the column, and returns no email key', async () => {
    const row = {
      ticket_id: '5',
      ticket_created_at: '2026-10-04 09:40:00.000',
      ticket_updated_at: '2026-10-04 09:40:00.000',
      requester_email: 'should-never-surface@example.com',
    };
    const { client, calls } = recordingClient((sql) =>
      sql.includes('ticket_updated_at') ? [row] : []
    );
    const t = await getSupportTicket({ version: 'v', ticketId: '5', includeEmail: false }, client);
    const ticketCall = calls.find((c) => c.query.includes('ticket_updated_at'));
    expect(ticketCall?.query).not.toMatch(/requester_email/);
    expect(t && 'requesterEmail' in t).toBe(false);
  });

  it('with the grant, the column is selected and returned', async () => {
    const row = { ticket_id: '5', requester_email: 'a@example.com' };
    const { client, calls } = recordingClient((sql) =>
      sql.includes('ticket_updated_at') ? [row] : []
    );
    const t = await getSupportTicket({ version: 'v', ticketId: '5', includeEmail: true }, client);
    expect(calls.find((c) => c.query.includes('ticket_updated_at'))?.query).toMatch(
      /requester_email/
    );
    expect(t?.requesterEmail).toBe('a@example.com');
  });
});

describe('the adapter is the only module that touches the router', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name === '__tests__' ? [] : files(p);
      return /\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
    });

  it('no other source file names a router table or view', () => {
    const all = files(SRC);
    expect(all.length).toBeGreaterThan(100); // positive control: the walk saw the app
    const touching = all
      .filter((f) => ROUTER_OBJECTS.some((t) => readFileSync(f, 'utf8').includes(t)))
      .map((f) => relative(SRC, f));
    expect(touching).toEqual(['lib/server/decision-sources/support.ts']);
  });
});
