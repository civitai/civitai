/**
 * Pure half of the bug-report-context skill: argument parsing, the read plan for a report, the
 * guard every read must pass, and the reading of the results. No I/O here, so all of it is
 * unit-tested (scripts/__tests__/bug-report-context-checks.test.ts); run.mjs does the running.
 */

export const MAX_TIMEOUT_S = 30;
export const MAX_SPAN_H = 25;
// Users on one error signature in the outage window before it reads as site-wide, not theirs.
export const SITE_WIDE_USERS = 20;

const posInt = (v, name) => {
  const n = Number(v);
  if (!/^\d+$/.test(String(v)) || !Number.isSafeInteger(n) || n <= 0)
    throw new Error(`${name} must be a positive integer, got ${v}`);
  return n;
};
const iso = (ms) => new Date(ms).toISOString();

export const CHECKS = [
  'errors',
  'ref',
  'outage',
  'images',
  'post',
  'ratings',
  'textscan',
  'generation',
  'feedback',
];
const DEFAULT_CHECKS = ['errors', 'ref', 'outage'];
const SCOPES = [
  {
    match: /post|image|media|upload|nsfw|rating/i,
    checks: ['images', 'post', 'ratings', 'textscan'],
  },
  { match: /generat|orchestrat|workflow|buzz/i, checks: ['generation'] },
  { match: /model|article|comment|bounty/i, checks: ['textscan'] },
];
// The reporter's clock can run behind the server's.
const AFTER_MS = 15 * 60_000;

export function parseArgs(argv) {
  const opts = { hours: 24, posts: [], paths: [], checks: null, json: null, plan: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--user') opts.user = posInt(next(), '--user');
    else if (a === '--at') opts.at = next();
    else if (a === '--ref') opts.ref = next();
    else if (a === '--route') opts.route = next();
    else if (a === '--paths') opts.paths = next().split(',').filter(Boolean);
    else if (a === '--post') opts.posts.push(posInt(next(), '--post'));
    else if (a === '--feedback') opts.feedback = posInt(next(), '--feedback');
    else if (a === '--hours') opts.hours = Number(next());
    else if (a === '--checks') opts.checks = next().split(',').filter(Boolean);
    else if (a === '--json') opts.json = next();
    else if (a === '--plan') opts.plan = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (!opts.user) throw new Error('--user is required');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/.test(opts.at ?? ''))
    throw new Error('--at must be an ISO time with a zone, e.g. 2026-01-02T03:04:05Z');
  const at = Date.parse(opts.at);
  if (!(opts.hours > 0 && opts.hours <= 24)) throw new Error('--hours must be in (0, 24]');
  if (opts.ref !== undefined && !/^[a-z0-9]{6,32}$/i.test(opts.ref))
    throw new Error('--ref must be the short hex ref');
  if (opts.paths.some((p) => !/^[\w.]+$/.test(p)))
    throw new Error('--paths are tRPC paths like post.reorderImages');
  if (opts.posts.length > 10) throw new Error('at most 10 --post');
  if (opts.checks) {
    if (opts.checks.includes('all')) opts.checks = [...CHECKS];
    const unknown = opts.checks.filter((c) => !CHECKS.includes(c));
    if (unknown.length)
      throw new Error(`unknown checks: ${unknown.join(', ')} (have ${CHECKS.join(', ')})`);
  }
  opts.end = iso(at + AFTER_MS);
  opts.start = iso(at - opts.hours * 3_600_000);
  opts.atIso = iso(at);
  return opts;
}

/** Which checks a report gets: the logs always, the rest by what its route and errors touch. */
export function pickChecks(opts) {
  if (opts.checks)
    return opts.checks.filter(
      (c) => (c !== 'ref' || opts.ref) && (c !== 'feedback' || opts.feedback)
    );
  const text = [opts.route, ...opts.paths].filter(Boolean).join(' ');
  const picked = new Set(DEFAULT_CHECKS);
  for (const s of SCOPES) if (s.match.test(text)) s.checks.forEach((c) => picked.add(c));
  if (opts.posts.length) ['post', 'ratings'].forEach((c) => picked.add(c));
  if (!opts.ref) picked.delete('ref');
  if (opts.feedback) picked.add('feedback');
  return CHECKS.filter((c) => picked.has(c));
}

// Server faults log the masked message on top and the real one under `cause`
// (buildServerFaultErrorLog in src/server/logging/client.ts).
const REASON =
  'extend cause_message = tostring(cause.message) | extend reason = iff(isempty(cause_message), tostring(message), cause_message)';
// The raw `message` rides along: on the 303 desk run the computed `reason` came back null in the
// rows, so reasonOf() falls back to it.
const ERROR_FIELDS = `${REASON} | project _time, path, code, reason, cause_message, message, errorRef, input`;
// One outage reaches users through many call sites: Prisma prefixes its message with the call
// ("Invalid `prisma.post.update()` invocation: ..."), so group on what follows, digits folded.
// No trim or cut here: signature() finishes the job on both sides, so they cannot drift apart.
// Axiom's replace_regex is (regex, rewrite, text), not (text, regex, rewrite): the other order is a
// 400 ("argument #1 must be a constant"), found on the 303 desk run.
const SIGNATURE = String.raw`extend sig = replace_regex(@"\d+", "N", replace_regex(@"(?s)^.*invocation:", "", reason))`;

/** The real error text of one logged line, whichever of its fields carried it. */
export function reasonOf(e) {
  const cause = typeof e?.cause === 'string' ? safeJson(e.cause) ?? { message: e.cause } : e?.cause;
  return (
    e?.reason || e?.cause_message || e?.['cause.message'] || cause?.message || e?.message || ''
  );
}

/**
 * Which database postgres-query read, from its stderr. Decided by its own hot-standby check (the
 * `Server: ..., in recovery: true` line), not the host: on a desk prod is reached through a tunnel
 * on 127.0.0.1, so the host says nothing.
 */
export function targetLabel(stderr) {
  const label = String(stderr).match(/^Target: (\S+ \([^)]*\))/m);
  if (!label) return null;
  const standby = /^Server: .*in recovery: true\s*$/m.test(String(stderr));
  return `Target: ${label[1]}, ${standby ? 'hot standby confirmed' : 'NOT confirmed as a replica'}`;
}

/** The reporter's side of SIGNATURE, then whitespace trimmed. Idempotent, and applied to the APL's sig too. */
export function signature(reason) {
  return String(reason ?? '')
    .replace(/^[\s\S]*invocation:/, '')
    .replace(/\d+/g, 'N')
    .trim();
}

/** Stage one: every read that needs only the report. { check, tool, query, limit, start?, end?, bound? } */
export function stageOne(opts, checks) {
  const { user, start, end } = opts;
  const reads = [];
  if (checks.includes('errors'))
    reads.push({
      check: 'errors',
      tool: 'axiom',
      start,
      end,
      limit: 200,
      // `user` is the session user id the tRPC handler logs with every error (src/pages/api/trpc/[trpc].ts).
      query: `['civitai-prod'] | where ['user'] == ${user} and isnotempty(path) | ${ERROR_FIELDS} | sort by _time desc | take 200`,
    });
  if (checks.includes('ref'))
    reads.push({
      check: 'ref',
      tool: 'axiom',
      start,
      end,
      limit: 20,
      query: `['civitai-prod'] | where errorRef == '${opts.ref}' | ${REASON} | project _time, ['user'], path, code, reason, cause_message, message, errorRef, input | take 20`,
    });
  if (checks.includes('feedback'))
    // The report itself: the Faro session id its browser attached (src/components/Feedback).
    reads.push({
      check: 'feedback',
      tool: 'pg',
      query: `SELECT id, "userId", "createdAt", context->>'sessionId' AS "sessionId" FROM "Feedback" WHERE id = ${opts.feedback} LIMIT 1`,
    });
  if (checks.includes('images'))
    // (userId, id) is indexed; createdAt/updatedAt are not, so take the newest by id and filter the
    // window here. Older images edited in the window come in through `post`.
    reads.push({
      check: 'images',
      tool: 'pg',
      limit: 100,
      query: `SELECT id, "postId", type, index, "createdAt", "updatedAt", ingestion, "blockedFor", "nsfwLevel", "nsfwLevelLocked", "scanRequestedAt", "scannedAt", "scanJobs" FROM "Image" WHERE "userId" = ${user} ORDER BY id DESC LIMIT 100`,
    });
  if (checks.includes('textscan'))
    // Never the held text or the scan's reasoning: what was held, when, and what became of it.
    reads.push({
      check: 'textscan',
      tool: 'pg',
      limit: 100,
      query: `SELECT id, "entityType", "entityId", label, status, "workflowId", "createdAt", "decidedAt", "hiddenAt", "restoredAt" FROM "TextScanHold" WHERE "userId" = ${user} AND "createdAt" >= '${start}' AND "createdAt" <= '${end}' ORDER BY "createdAt" DESC LIMIT 100`,
    });
  if (checks.includes('generation'))
    // Sorted by createdAt only, so the time bound is what keeps this cheap (~24h of steps). No userId
    // column: the workflow id starts with it. Succeeded steps are not read.
    reads.push({
      check: 'generation',
      tool: 'ch',
      limit: 200,
      query: `SELECT createdAt, workflowId, type, status, failureClass FROM orchestration.workflowSteps WHERE createdAt BETWEEN parseDateTime64BestEffort('${start}') AND parseDateTime64BestEffort('${end}') AND startsWith(workflowId, '${user}-') AND status != 'succeeded' ORDER BY createdAt DESC LIMIT 200`,
    });
  return reads;
}

const inWindow = (t, opts) => t && t >= opts.start && t <= opts.end;
const ts = (v) => {
  const d = new Date(v);
  return v && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};
const okId = (v) => Number.isSafeInteger(Number(v)) && Number(v) > 0;

/** Post and image ids stage one pointed at: --post, error inputs, images touched in the window. */
export function idsFromStageOne(opts, results) {
  const posts = new Set(opts.posts);
  const images = new Set();
  for (const e of results.errors ?? []) {
    const input = typeof e.input === 'string' ? safeJson(e.input) : e.input;
    for (const [k, v] of walk(input)) {
      if (!Number.isSafeInteger(v) || v <= 0) continue;
      if (/^postId$/i.test(k)) posts.add(v);
      if (/^(imageId|imageIds)$/i.test(k)) images.add(v);
    }
  }
  for (const img of results.images ?? []) {
    if (!inWindow(ts(img.createdAt), opts) && !inWindow(ts(img.updatedAt), opts)) continue;
    if (okId(img.id)) images.add(Number(img.id));
    if (okId(img.postId)) posts.add(Number(img.postId));
  }
  return { posts: [...posts].slice(0, 10), images: [...images].slice(0, 200) };
}

export function stageTwo(opts, checks, ids) {
  const reads = [];
  const list = (a) => a.map((n) => posInt(n, 'id')).join(', ');
  if (checks.includes('post') && ids.posts.length) {
    reads.push({
      check: 'post',
      tool: 'pg',
      limit: 10,
      query: `SELECT id, "userId", "createdAt", "updatedAt", "publishedAt", "nsfwLevel", availability, "modelVersionId" FROM "Post" WHERE id IN (${list(
        ids.posts
      )}) LIMIT 10`,
    });
    reads.push({
      check: 'postImages',
      tool: 'pg',
      limit: 300,
      query: `SELECT id, "postId", type, index, ingestion, "nsfwLevel", "nsfwLevelLocked", "scannedAt", "updatedAt" FROM "Image" WHERE "postId" IN (${list(
        ids.posts
      )}) ORDER BY "postId", index LIMIT 300`,
    });
  }
  if (checks.includes('ratings') && ids.images.length)
    reads.push({
      check: 'ratings',
      tool: 'pg',
      limit: 200,
      // The key is (imageId, userId): lead with imageId or this scans the table.
      query: `SELECT "imageId", "nsfwLevel", status, "createdAt" FROM "ImageRatingRequest" WHERE "imageId" IN (${list(
        ids.images
      )}) AND "userId" = ${opts.user} LIMIT 200`,
    });
  return reads;
}

// Faro data in Loki is kept this long (FARO_LOKI_RETENTION_HOURS in apps/moderator/src/lib/feedback.ts).
export const FARO_RETENTION_HOURS = 72;

/**
 * Where the reporter's browser telemetry is, for someone with Grafana to open. The skill cannot read
 * Loki itself. Raw substring, never a logfmt filter: the id appears under two keys in that stream
 * (faroSessionExpr in apps/moderator/src/lib/feedback.ts).
 */
export function faroLines(row, opts, now) {
  if (!row) return ['Faro: the feedback row was not found.'];
  const lines = [];
  if (Number(row.userId) !== opts.user)
    lines.push(
      `Faro: WARNING the feedback row belongs to user ${row.userId}, not --user ${opts.user}.`
    );
  if (!row.sessionId) {
    lines.push(
      'Faro: no session id on the report (Faro does not run in dev, previews or ad-blocked sessions).'
    );
    return lines;
  }
  const expires = new Date(row.createdAt).getTime() + FARO_RETENTION_HOURS * 3_600_000;
  lines.push(`Faro: Loki query {source="faro-rum"} |= ${JSON.stringify(String(row.sessionId))}`);
  lines.push(
    now >= expires
      ? `Faro: EXPIRED, the session's data left Loki at ${iso(expires)}.`
      : `Faro: kept until ${iso(expires)}; open it in Grafana Explore before then.`
  );
  return lines;
}

export const OUTAGE_COLUMNS = ['n', 'first', 'last', 'users'];

/** Site-wide errors around the reporter's last error: an outage shows as many users, one signature. */
export function outageRead(opts, results) {
  const times = (results.errors ?? [])
    .map((e) => ts(e._time))
    .filter(Boolean)
    .sort();
  const center = Date.parse(times.at(-1) ?? opts.atIso);
  return {
    check: 'outage',
    tool: 'axiom',
    start: iso(center - 10 * 60_000),
    end: iso(center + 10 * 60_000),
    // No `limit`: prod fills the top 100 groups every time, and they are ordered by row count, so a
    // signature with enough users to read as site-wide is among them.
    query: `['civitai-prod'] | where type == 'error' | ${REASON} | ${SIGNATURE} | summarize n = count(), first = min(_time), last = max(_time), users = dcount(['user']) by sig | order by n desc | take 100`,
  };
}

// ---- The guard ------------------------------------------------------------------------------
//
// A read runs only if it is, character for character, one of the queries this file builds, with
// nothing varying but ids, the ref and times. Its shape (those values replaced by placeholders)
// must be in KNOWN_SHAPES, which is computed below from the builders themselves. So nothing a
// stranger hand-writes can run, however it is quoted or commented; a new check is reviewed by
// being added to a builder. The values that do vary are validated where they enter (posInt, the
// ISO and ref patterns), and every time in a read must fall in one window of at most MAX_SPAN_H.

const ISO_LITERAL = /'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)'/g;

export function shapeOf(query) {
  return String(query)
    .replace(ISO_LITERAL, "'<T>'")
    .replace(/errorRef == '[a-zA-Z0-9]{6,32}'/, "errorRef == '<REF>'")
    .replace(/\bIN \(\d+(?:, \d+)*\)/g, 'IN (<IDS>)')
    .replace(/(==?) \d+\b/g, '$1 <N>')
    .replace(/'\d+-'/g, "'<N>-'");
}

const KNOWN_SHAPES = (() => {
  const opts = parseArgs([
    '--user',
    '1',
    '--at',
    '2000-01-02T00:00:00Z',
    '--ref',
    'abcdef',
    '--feedback',
    '1',
    '--checks',
    'all',
  ]);
  const reads = [
    ...stageOne(opts, CHECKS),
    ...stageTwo(opts, CHECKS, { posts: [1], images: [1] }),
    outageRead(opts, {}),
  ];
  return new Map(reads.map((r) => [shapeOf(r.query), r]));
})();

function assertSpan(times) {
  const ms = times.map((t) => Date.parse(t));
  if (ms.some(Number.isNaN)) throw new Error('refused: unparseable time');
  const span = (Math.max(...ms) - Math.min(...ms)) / 3_600_000;
  if (span > MAX_SPAN_H) throw new Error(`refused: time span ${span}h`);
}

export function assertKnownRead(read) {
  const known = KNOWN_SHAPES.get(shapeOf(read.query));
  if (!known || known.tool !== read.tool || known.check !== read.check)
    throw new Error('refused: not a query this skill builds');
  const times = [...String(read.query).matchAll(ISO_LITERAL)].map((m) => m[1]);
  // Every time slot holds a real time, never the placeholder text itself.
  if (times.length !== (known.query.match(ISO_LITERAL) ?? []).length)
    throw new Error('refused: not a query this skill builds');
  if (read.tool === 'axiom') {
    const isoTime = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
    if (!isoTime.test(read.start) || !isoTime.test(read.end) || read.start >= read.end)
      throw new Error('refused: Axiom start/end must be ISO times, start before end');
    times.push(read.start, read.end);
  }
  if (times.length) assertSpan(times);
  return read;
}

export function assertTimeout(seconds) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_S)
    throw new Error(`refused: timeout ${seconds}s (max ${MAX_TIMEOUT_S})`);
  return seconds;
}

/** Guard a read and turn it into the argv for the existing skill script. */
export function toCommand(read) {
  assertKnownRead(read);
  const timeout = String(assertTimeout(MAX_TIMEOUT_S));
  if (read.tool === 'pg')
    return [
      '.claude/skills/postgres-query/query.mjs',
      '--prod',
      '--json',
      '--timeout',
      timeout,
      read.query,
    ];
  if (read.tool === 'ch')
    return [
      '.claude/skills/clickhouse-query/query.mjs',
      '--json',
      '--quiet',
      '--timeout',
      timeout,
      read.query,
    ];
  return [
    '.claude/skills/axiom/axiom.mjs',
    'query',
    read.query,
    '--start',
    read.start,
    '--end',
    read.end,
    '--format',
    'legacy',
    '--json',
  ];
}

// ---- Reading the results --------------------------------------------------------------------

/**
 * Rows out of a skill script's --json output. Throws on anything that is not a result: axiom.mjs
 * prints an error body (or an unparsed body) and exits 0, and read as rows that would be an empty
 * result.
 */
export function rowsOf(tool, out, columns = []) {
  if (tool !== 'axiom') {
    if (!Array.isArray(out?.rows)) throw new Error(`${tool}: output has no rows`);
    return out.rows;
  }
  if (out?._error)
    throw new Error(`axiom ${out.statusCode}: ${out.message ?? out.body ?? 'error'}`);
  if (Array.isArray(out?.matches) && out.matches.length)
    return out.matches.map((m) => ({ _time: m._time, ...m.data }));
  if (!out?.buckets && !Array.isArray(out?.matches))
    throw new Error('axiom: output is not a query result');
  // Legacy summarize: per group, aggregations in the order the APL named them. Name them by
  // position, since the payload's own label may be the function, not the alias.
  const groups = out.buckets?.totals?.length
    ? out.buckets.totals
    : (out.buckets?.series ?? []).flatMap((s) => s.groups ?? []);
  return groups.map((g) => ({
    ...g.group,
    ...Object.fromEntries(
      (g.aggregations ?? []).map((a, i) => [columns[i] ?? a.alias ?? a.op, a.value])
    ),
  }));
}

/**
 * What the reporter most likely hit. `failed` is the set of checks whose read failed: a failed
 * read is never reported as an absence.
 */
export function reading(results, failed, checks = CHECKS) {
  const lines = [];
  for (const c of failed)
    lines.push(`${c}: NOT READ, so nothing here rules out what it would have shown.`);
  for (const c of ['errors', 'outage'])
    if (!checks.includes(c))
      lines.push(`${c}: NOT RUN (not among --checks), so no conclusion is drawn.`);
  if (['errors', 'outage'].some((c) => failed.has(c) || !checks.includes(c))) return lines;
  const outage = (results.outage ?? []).map((o) => ({ ...o, sig: signature(o.sig) }));
  const mine = new Map();
  for (const e of results.errors ?? []) {
    const sig = signature(reasonOf(e));
    if (sig) mine.set(sig, mine.get(sig) || !!e.cause_message);
  }
  const shared = outage.filter((o) => Number(o.users) >= SITE_WIDE_USERS);
  const hits = shared.filter((o) => mine.has(o.sig));
  for (const o of hits) {
    const note = mine.get(o.sig)
      ? ''
      : ' (no cause was logged for it: if the message is generic, confirm by hand)';
    lines.push(
      `SITE-WIDE: the reporter's error "${o.sig.slice(0, 160)}" hit ${o.users} users (${
        o.n
      } rows) from ${ts(o.first) ?? o.first} to ${
        ts(o.last) ?? o.last
      }. Likely an incident, not a bug in what they were doing${note}.`
    );
  }
  if (!hits.length && shared.length)
    lines.push(
      `Site-wide errors were running (top: "${shared[0].sig.slice(0, 160)}", ${
        shared[0].users
      } users), but none matches the reporter's own errors. Compare by hand.`
    );
  if (!shared.length)
    lines.push(
      "No site-wide error spike around the reporter's last error. Read the timeline for what they were doing when it failed."
    );
  if (!(results.errors ?? []).length)
    lines.push(
      'No tRPC errors logged for this user in the window (UNAUTHORIZED, FORBIDDEN, TOO_MANY_REQUESTS, SERVICE_UNAVAILABLE, some expected 404s and client aborts are never logged).'
    );
  return lines;
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function* walk(v, key = '', depth = 0) {
  if (depth > 6 || v === null || v === undefined) return;
  if (Array.isArray(v)) for (const x of v) yield* walk(x, key, depth + 1);
  else if (typeof v === 'object')
    for (const [k, x] of Object.entries(v)) yield* walk(x, k, depth + 1);
  else yield [key, v];
}
