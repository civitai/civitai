import { describe, expect, it } from 'vitest';

// Plain .mjs shipped with the bug-report-context skill, run by node with no build step.
import {
  OUTAGE_COLUMNS,
  assertKnownRead,
  faroLines,
  reasonOf,
  targetLabel,
  idsFromStageOne,
  outageRead,
  parseArgs,
  pickChecks,
  reading,
  rowsOf,
  signature,
  stageOne,
  stageTwo,
  toCommand,
} from '../../.claude/skills/bug-report-context/checks.mjs';

// Synthetic report values throughout.
const base = ['--user', '42', '--at', '2031-03-04T05:06:07Z'];
const full = () => {
  const opts = parseArgs([
    ...base,
    '--ref',
    'abc123def456',
    '--checks',
    'all',
    '--post',
    '7',
    '--feedback',
    '9',
  ]);
  const checks = pickChecks(opts);
  return [
    ...stageOne(opts, checks),
    ...stageTwo(opts, checks, { posts: [7, 8], images: [8, 9, 10] }),
    outageRead(opts, {}),
  ];
};
const read = (check: string) => full().find((r) => r.check === check)!;

describe('bug-report-context runs only the queries it builds', () => {
  // Positive control for every refusal below: each read the skill builds passes.
  it('passes every read the skill builds for a full report', () => {
    const reads = full();
    expect(reads.map((r) => r.check).sort()).toEqual(
      [
        'errors',
        'feedback',
        'generation',
        'images',
        'outage',
        'post',
        'postImages',
        'ratings',
        'ref',
        'textscan',
      ].sort()
    );
    for (const r of reads) expect(() => toCommand(r)).not.toThrow();
  });

  // Known bypasses of a refusal-list guard, plus the obvious ones. Each is refused because it is not
  // one of the built shapes, whatever its quoting or comments.
  it.each([
    ['a write', 'images', `UPDATE "Image" SET "nsfwLevel" = 1 WHERE id = 1`],
    ['a second statement', 'images', `${read('images').query}; DELETE FROM "Image"`],
    [
      'a statement behind a quote in a comment',
      'images',
      `SELECT id FROM "Image" WHERE id = 1 -- '\n; DROP TABLE "Image"; --'\n LIMIT 1`,
    ],
    ['a bigger LIMIT', 'images', read('images').query.replace('LIMIT 100', 'LIMIT 100000')],
    ['a widening OR', 'images', read('images').query.replace('ORDER BY', 'OR 1 = 1 ORDER BY')],
    [
      'query_to_xml',
      'images',
      `SELECT query_to_xml('select email from "User"', true, true, '') FROM "Image" WHERE "userId" = 1 ORDER BY id DESC LIMIT 100`,
    ],
    ['another column', 'images', read('images').query.replace('"scanJobs"', 'url')],
    ['a dollar-quoted string', 'post', `SELECT $$'$$ FROM "Post" WHERE id IN (1) LIMIT 10`],
    [
      'a ClickHouse table function',
      'generation',
      `SELECT x FROM url('http://h/', CSV, 'x String') WHERE 1 LIMIT 1`,
    ],
    [
      'a ClickHouse bound in a comment',
      'generation',
      `SELECT createdAt FROM orchestration.workflowSteps WHERE 1 = 1 /* createdAt BETWEEN parseDateTime64BestEffort('2031-03-03T05:06:07.000Z') AND parseDateTime64BestEffort('2031-03-04T05:21:07.000Z') */ LIMIT 10`,
    ],
    [
      'a negated ClickHouse bound',
      'generation',
      read('generation').query.replace('WHERE createdAt', 'WHERE NOT createdAt'),
    ],
    [
      'an Axiom comment',
      'errors',
      `${read('errors').query.replace(/ \| take 200$/, '')} // | take 1`,
    ],
    ['a second Axiom dataset', 'errors', `['civitai-prod'] | take 1; ['other'] | take 1`],
    [
      'a relative Axiom time',
      'errors',
      read('errors').query.replace('isnotempty(path)', '_time > ago(90d)'),
    ],
  ])('refuses %s', (_, check, query) => {
    const r = read(check);
    expect(() => assertKnownRead({ ...r, query })).toThrow(/not a query this skill builds/);
  });

  it('refuses placeholder text, a recased ref match and loose Axiom times', () => {
    const t = read('textscan');
    const placeholder = t.query.replace(/'2031-03-03T05:06:07\.000Z'/, "'<T>'");
    expect(placeholder).not.toBe(t.query);
    expect(() => assertKnownRead({ ...t, query: placeholder })).toThrow(
      /not a query this skill builds/
    );
    const r = read('ref');
    expect(() =>
      assertKnownRead({ ...r, query: r.query.replace('errorRef ==', 'ERRORREF ==') })
    ).toThrow(/not a query this skill builds/);
    expect(() => assertKnownRead({ ...r, start: 'March 4 2031' })).toThrow(/ISO times/);
    expect(() => assertKnownRead({ ...r, start: r.end, end: r.start })).toThrow(/start before end/);
  });

  it('refuses a built query moved to another tool or check', () => {
    expect(() => assertKnownRead({ ...read('images'), tool: 'ch' })).toThrow(
      /not a query this skill builds/
    );
    expect(() => assertKnownRead({ ...read('post'), check: 'images' })).toThrow(
      /not a query this skill builds/
    );
  });

  it('refuses a built query whose times span more than a day', () => {
    const r = read('generation');
    const query = r.query.replace(/'2031-03-03T05:06:07\.000Z'/, "'2030-01-01T00:00:00.000Z'");
    expect(query).not.toBe(r.query);
    expect(() => assertKnownRead({ ...r, query })).toThrow(/time span/);
    const e = read('errors');
    expect(() => assertKnownRead({ ...e, start: '2030-01-01T00:00:00.000Z' })).toThrow(/time span/);
  });
});

describe('bug-report-context inputs', () => {
  it('refuses a user id, ref or time that could carry text into a query', () => {
    expect(() => parseArgs(['--user', '1 OR 1=1', '--at', '2031-03-04T05:06:07Z'])).toThrow(
      /positive integer/
    );
    expect(() => parseArgs([...base, '--ref', "x' or 1=1"])).toThrow(/--ref/);
    expect(() => parseArgs(['--user', '1', '--at', '4 Mar 2031 Z'])).toThrow(/ISO time/);
  });

  it('scopes a post-edit report to images, posts, ratings and text scans, not generation', () => {
    const opts = parseArgs([
      ...base,
      '--route',
      '/posts/[postId]/edit',
      '--paths',
      'post.reorderImages',
    ]);
    expect(pickChecks(opts)).toEqual(['errors', 'outage', 'images', 'post', 'ratings', 'textscan']);
  });

  it('takes post and image ids from logged error inputs', () => {
    const opts = parseArgs(base);
    const ids = idsFromStageOne(opts, {
      errors: [
        { input: JSON.stringify({ json: { postId: 11, imageIds: [21, 22] } }) },
        { input: { id: 5 } },
      ],
    });
    expect(ids).toEqual({ posts: [11], images: [21, 22] });
  });
});

// Synthetic shapes: the Axiom legacy summarize payload (buckets.totals, aggregations by position)
// and a DB-login outage reaching users through several Prisma call sites. Replace with a captured
// payload once one exists.
const LOGIN = 'server login has been failing, try again later (server_login_retry)';
const prisma = (call: string, msg = LOGIN) =>
  `\nInvalid \`prisma.${call}()\` invocation:\n\n\n${msg}`;
const agg = (n: number, users: number) => [
  { op: 'count', value: n },
  { op: 'min', value: '2031-03-04T05:00:02Z' },
  { op: 'max', value: '2031-03-04T05:04:58Z' },
  { op: 'dcount', value: users },
];
// What the APL SIGNATURE leaves as the group key: the call-site prefix gone, whitespace kept.
const outagePayload = {
  buckets: {
    totals: [
      { group: { sig: `\n\n\n${LOGIN}` }, aggregations: agg(8000, 2100) },
      {
        group: { sig: 'Unique constraint failed on the fields: (`id`)' },
        aggregations: agg(40, 3),
      },
    ],
  },
};
const outage = () => rowsOf('axiom', outagePayload, OUTAGE_COLUMNS);

describe('bug-report-context Faro pointer', () => {
  const opts = parseArgs(base);
  const row = { userId: 42, createdAt: '2031-03-04T05:06:07.000Z', sessionId: 'aB3dE5gH7j' };
  const created = Date.parse(row.createdAt);

  it('prints the raw-substring Loki query while the data is kept', () => {
    const lines = faroLines(row, opts, created + 71 * 3_600_000).join('\n');
    expect(lines).toContain('{source="faro-rum"} |= "aB3dE5gH7j"');
    expect(lines).toMatch(/kept until 2031-03-07T05:06:07\.000Z/);
  });

  it('says expired at exactly the retention window', () => {
    expect(faroLines(row, opts, created + 72 * 3_600_000).join('\n')).toMatch(/EXPIRED/);
  });

  it("warns when the feedback row is another user's", () => {
    expect(faroLines({ ...row, userId: 7 }, opts, created).join('\n')).toMatch(/belongs to user 7/);
  });
});

describe('bug-report-context against the real tools', () => {
  // The other order is an Axiom 400, and the outage check then reads NOT READ on every report.
  it("calls Axiom's replace_regex as (regex, rewrite, text)", () => {
    expect(read('outage').query).toContain(
      String.raw`replace_regex(@"\d+", "N", replace_regex(@"(?s)^.*invocation:", "", reason))`
    );
  });

  // Prod can sit behind a local forward, so the host cannot tell prod from a local copy;
  // postgres-query's own hot-standby check can.
  it('names the database by its hot-standby check, not its host', () => {
    const tunnel =
      'Target: PROD (read-only) -> ro@127.0.0.1:6543/civitai [X]\nServer: 10.0.0.9/32, in recovery: true\n';
    expect(targetLabel(tunnel)).toBe('Target: PROD (read-only), hot standby confirmed');
    expect(targetLabel('Target: PROD (read-only) -> u@db.example.net:5432/civitai [X]\n')).toMatch(
      /NOT confirmed/
    );
  });

  it('falls back to the raw message when the computed reason is missing', () => {
    expect(reasonOf({ reason: null, cause_message: null, message: LOGIN })).toBe(LOGIN);
    expect(reasonOf({ reason: 'r', message: 'm' })).toBe('r');
  });
});

describe('bug-report-context reading', () => {
  it('names a site-wide outage when the reporter hit it through a different call site', () => {
    expect(outage()[0]).toMatchObject({ n: 8000, users: 2100 });
    const errors = [
      { reason: prisma('post.update'), cause_message: prisma('post.update') },
      { reason: prisma('image.findFirst'), cause_message: prisma('image.findFirst') },
    ];
    const lines = reading({ errors, outage: outage() }, new Set());
    expect(lines[0]).toMatch(
      /^SITE-WIDE: .*server login has been failing.* 2100 users \(8000 rows\)/
    );
    expect(lines.join('\n')).not.toMatch(/confirm by hand/);
  });

  it('matches a long reason the same on both sides', () => {
    const long = `${'x'.repeat(159)} ${'y'.repeat(60)}`;
    const payload = {
      buckets: { totals: [{ group: { sig: `\n${long}` }, aggregations: agg(500, 300) }] },
    };
    const lines = reading(
      {
        errors: [{ reason: prisma('post.update', long), cause_message: 'x' }],
        outage: rowsOf('axiom', payload, OUTAGE_COLUMNS),
      },
      new Set()
    );
    expect(lines[0]).toMatch(/^SITE-WIDE/);
  });

  it('does not call a spike site-wide when the reporter hit something else', () => {
    const lines = reading(
      {
        errors: [{ reason: 'Cannot read properties of undefined', cause_message: 'x' }],
        outage: outage(),
      },
      new Set()
    );
    expect(lines[0]).toMatch(/none matches the reporter's own errors/);
  });

  it('folds digits so one error with different ids is one signature', () => {
    expect(signature('Record 123 not found')).toBe(signature('Record 4321 not found'));
  });

  it.each([
    [
      'an error body',
      { _error: true, statusCode: 400, message: 'unknown field' },
      /axiom 400: unknown field/,
    ],
    ['an unparsed body', { raw: '<html>' }, /not a query result/],
  ])('throws on %s from Axiom instead of reading it as no rows', (_, out, why) => {
    expect(() => rowsOf('axiom', out)).toThrow(why);
  });

  it('reads summarize groups from series when totals are absent', () => {
    const rows = rowsOf(
      'axiom',
      { buckets: { series: [{ groups: outagePayload.buckets.totals }] } },
      OUTAGE_COLUMNS
    );
    expect(rows.map((r) => r.users)).toEqual([2100, 3]);
  });

  it('says NOT READ and draws no conclusion when the reporter errors were not read', () => {
    const lines = reading({ outage: outage() }, new Set(['errors'])).join('\n');
    expect(lines).toMatch(/errors: NOT READ/);
    expect(lines).not.toMatch(/No tRPC errors|none matches|No site-wide|SITE-WIDE/);
  });

  it('draws no conclusion from log checks that were not run', () => {
    const lines = reading({}, new Set(), ['images']).join('\n');
    expect(lines).toMatch(/errors: NOT RUN/);
    expect(lines).toMatch(/outage: NOT RUN/);
    expect(lines).not.toMatch(/No tRPC errors|No site-wide/);
  });

  it('says NOT READ, never "no spike", when the outage read failed', () => {
    const lines = reading({ errors: [{ reason: LOGIN }] }, new Set(['outage', 'images'])).join(
      '\n'
    );
    expect(lines).toMatch(/outage: NOT READ/);
    expect(lines).toMatch(/images: NOT READ/);
    expect(lines).not.toMatch(/No site-wide/);
  });
});
