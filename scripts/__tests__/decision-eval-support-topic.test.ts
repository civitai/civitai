import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import type * as ClickhouseClient from '@clickhouse/client';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

const clickhouse = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('@clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  createClient: clickhouse.createClient,
}));

import { NODES } from '../decision-eval/nodes';
import {
  buildSupportState,
  CANNOT_TELL,
  dropDevSharingTestGroup,
  goldFromLabel,
  groupKeyFor,
  INCUMBENT_TOPIC_MAP,
  keywordBaseline,
  NODE_ID,
  parseStrataCsv,
  periodOf,
  redact,
  redactionWindow,
  supportTopicNode,
  TOPIC_CLASSES,
  type SupportTicketRaw,
} from '../decision-eval/nodes/support-topic';
import { assertNoPii } from '../decision-eval/safety';
import {
  fittedThresholds,
  parseStrataWeights,
  weightedSummary,
} from '../decision-eval/nodes/support-topic-weighted';
import type { ManifestItem, NormalizedAnswer, Prediction } from '../decision-eval/types';

function raw(overrides: Partial<SupportTicketRaw> = {}): SupportTicketRaw {
  return {
    ticketId: '70001',
    createdAt: '2026-09-14T10:00:00.000Z',
    subject: 'Deposit missing',
    firstMessage: 'I sent USDT an hour ago and nothing arrived.',
    latestMessages: 'Any update?',
    memberTier: 'gold',
    lang: 'en',
    incumbentTopic: 'crypto',
    requesterId: '9001',
    requesterEmail: 'pat.doe@example.org',
    username: 'PatTheCreator',
    stratum: 'crypto',
    ...overrides,
  };
}

function choice(value: string, confidence = 0.8): NormalizedAnswer[] {
  return [
    {
      id: 'topic',
      type: 'choice',
      value,
      probabilities: null,
      confidence,
      unknown: null,
      abstained: null,
    },
  ];
}

describe('support.topic state', () => {
  const leaky = raw({
    username: 'Pat+Creator(1)',
    subject: 'Help for pat+creator(1), pat+creator(1) here',
    firstMessage:
      'Hi, I am PatTheCreator (pat.doe on discord). Mail me at pat.doe@example.org or cc my friend jo.smith@another.net, or see https://civitai.com/user/PatTheCreator and www.example.com, ping @mod_team.',
    latestMessages:
      'Still waiting @support_lead. PAT+CREATOR(1) again: civitai.com/user/SomeOtherUser, wallet 0x52908400098527886e0f7030069857d2e4169ee7, call +1 (415) 555-0134',
  });

  it('control: the harness PII check rejects the unredacted text', () => {
    expect(() =>
      assertNoPii('x', { a: leaky.subject, b: leaky.firstMessage, c: leaky.latestMessages })
    ).toThrow();
  });

  it('redacts everything the harness PII check looks for, and the requester by name', () => {
    const state = buildSupportState(leaky);
    expect(() => assertNoPii('x', state)).not.toThrow();
    const all = Object.values(state).join('\n').toLowerCase();
    expect(all).not.toContain('pat+creator(1)');
    expect(all).not.toContain('pat.doe');
    expect(all).not.toContain('another.net');
    expect(all).not.toContain('someotheruser');
    expect(state.latest_messages).toContain('wallet [id]');
    expect(all).not.toContain('555-0134');
  });

  it('sends only the fields the question needs: no incumbent answer, no requester ids', () => {
    expect(Object.keys(buildSupportState(raw())).sort()).toEqual(
      ['first_message', 'latest_messages', 'member_tier', 'subject'].sort()
    );
  });

  it('keeps the start of the first message and the end of the thread', () => {
    const state = buildSupportState(
      raw({
        firstMessage: `HEAD ${'x '.repeat(5_000)}`,
        latestMessages: `${'y '.repeat(5_000)}TAIL`,
      })
    );
    expect(state.first_message.startsWith('HEAD')).toBe(true);
    expect(state.first_message.length).toBe(6000);
    expect(state.latest_messages.endsWith('TAIL')).toBe(true);
    expect(state.latest_messages.length).toBe(3000);
  });

  it('does not treat a short or empty username as something to strip', () => {
    expect(redact('abc ab', ['', ' ', 'ab'])).toBe('abc ab');
    expect(redact('hi bob here, bob.', ['bob'])).toBe('hi [user] here, [user].');
  });

  it('strips a username only as a whole word, so a topic word survives', () => {
    expect(redact('I bought buzz, then buzzed you; buzz.', ['buzz'])).toBe(
      'I bought [user], then buzzed you; [user].'
    );
    expect(redact('xbuzz buzzy', ['buzz'])).toBe('xbuzz buzzy');
  });

  it('redacts before cutting, so an identifier on the boundary leaves no partial', () => {
    const cut = 'x '.repeat(2995) + 'jo.smith@another.net trailing';
    const state = buildSupportState(
      raw({
        firstMessage: cut,
        latestMessages: '0x52908400098527886e0f7030069857d2e4169ee7 ' + 'y '.repeat(1490),
      })
    );
    expect(state.first_message).not.toContain('jo.smith');
    expect(state.latest_messages).not.toMatch(/[a-f0-9]{8}/);
  });

  it('leaves an amount and a short order number alone', () => {
    expect(redact('Paid 25.00 USD for 5000 buzz, order 123456')).toBe(
      'Paid 25.00 USD for 5000 buzz, order 123456'
    );
  });
});

describe('support.topic labels', () => {
  it('maps the 13 incumbent slugs exactly; the money pair must never swap', () => {
    expect(INCUMBENT_TOPIC_MAP).toEqual({
      'billing-buzz': 'billing_buzz',
      crypto: 'crypto',
      'payment-refund': 'payment_refund',
      'account-issue': 'account',
      'technical-bug': 'technical_bug',
      'generation-quality': 'generation_quality',
      'model-quality': 'model_quality',
      'nsfw-moderation': 'moderation',
      'image-moderation-appeal': 'moderation',
      'abuse-report': 'abuse_report',
      'feature-request': 'feature_request',
      'mobile-app': 'technical_bug',
      other: 'other',
    });
  });

  it('declares cannot_tell as a class, so a human cannot-tell is valid gold', () => {
    expect(TOPIC_CLASSES).toContain(CANNOT_TELL);
  });

  it('throws on a label outside the incumbent vocab instead of silently dropping it', () => {
    expect(() => goldFromLabel('not-a-topic', '')).toThrow(/not an incumbent topic/);
  });

  it.each([
    ['nsfw-moderation', '', 'moderation'],
    ['image-moderation-appeal', '', 'moderation'],
    ['account-issue', '', 'account'],
    ['mobile-app', '', 'technical_bug'],
    ['', 'cannot-tell', CANNOT_TELL],
    ['', 'cannot-tell: asks two things', CANNOT_TELL],
    ['', 'come back later', null],
  ])('label %j with notes %j is gold %j', (topic, notes, gold) => {
    expect(goldFromLabel(topic, notes)).toBe(gold);
  });
});

describe('support.topic formats', () => {
  const choice12 = supportTopicNode.formats.choice12;
  const router13 = supportTopicNode.formats.router13;

  it('declares exactly the node classes as options', () => {
    const qs = choice12.questions;
    if (!Array.isArray(qs) || qs[0].type !== 'choice') throw new Error('expected an inline choice');
    expect(qs[0].options.map((o) => o.key)).toEqual([...TOPIC_CLASSES]);
  });

  it('a model cannot_tell is an abstention, not a prediction', () => {
    expect(choice12.mapAnswer(choice(CANNOT_TELL))).toEqual({
      pred: null,
      confidence: 0.8,
      abstained: true,
    });
    expect(choice12.mapAnswer(choice('crypto')).pred).toBe('crypto');
  });

  it('keeps the router wording out of the repo and maps its slugs', () => {
    expect(router13.questions).toEqual({ fromDataDir: 'router13.questions.json' });
    expect(router13.mapAnswer(choice('image-moderation-appeal')).pred).toBe('moderation');
    expect(() => router13.mapAnswer(choice('billing'))).toThrow(/no mapping/);
  });
});

describe('support.topic baselines and slices', () => {
  it.each([
    ['My ETH deposit never showed', 'crypto'],
    ['I want a refund please', 'payment_refund'],
    ['I bought buzz with my card and it is gone', 'billing_buzz'],
    ['The page will not load', null],
  ])('keyword rule: %j -> %j', (text, label) => {
    expect(keywordBaseline(raw({ subject: '', firstMessage: text }))).toBe(label);
  });

  it('reports the incumbent mapped onto node classes', () => {
    expect(
      supportTopicNode.baselines?.(raw({ incumbentTopic: 'nsfw-moderation' }))?.incumbent
    ).toBe('moderation');
  });

  it('slices the test split by month so each period reports separately', () => {
    expect(periodOf(raw({ createdAt: '2026-08-20T00:00:00.000Z' }))).toBe('2026-08');
    expect(periodOf(raw())).toBe('2026-09');
    expect(periodOf(raw({ stratum: undefined }))).toBe('dev');
  });
});

describe('support.topic plumbing', () => {
  it('reads a strata sidecar by header name, with CRLF line endings', () => {
    const sampler =
      'ticket_id,stratum,stratum_population,stratum_sampled,weight,double_labelled\r\n' +
      '101,crypto,50,20,2.5,0\r\n102,_rest,400,40,10,1\r\n';
    expect([...parseStrataCsv(sampler)]).toEqual([
      ['101', 'crypto'],
      ['102', '_rest'],
    ]);
    // With stratum as the last column, a bare '\n' split would leave '\r' on it.
    expect([...parseStrataCsv('ticket_id,stratum\r\n101,crypto\r\n')]).toEqual([['101', 'crypto']]);
  });

  it('group keys depend on the salt, so they cannot be recomputed from requester ids alone', () => {
    expect(groupKeyFor('s1', '9001', 't1')).toBe(groupKeyFor('s1', '9001', 't2'));
    expect(groupKeyFor('s1', '9001', 't1')).not.toBe(groupKeyFor('s2', '9001', 't1'));
    expect(groupKeyFor('s1', '', 't1')).not.toBe(groupKeyFor('s1', '', 't2'));
  });

  it('is registered with the harness', () => {
    expect(NODES[NODE_ID]).toBe(supportTopicNode);
  });
});

describe('support.topic weighted summary', () => {
  const item = (itemId: string, incumbent: string | null): ManifestItem => ({
    itemId,
    groupKey: itemId,
    ts: '2026-09-10T00:00:00.000Z',
    split: 'test',
    state: {},
    baselines: { incumbent },
  });
  const pred = (
    itemId: string,
    p: string | null,
    confidence: number | null,
    extra: Partial<Prediction> = {}
  ): Prediction => ({
    itemId,
    runKey: 'k',
    status: 'ok',
    pred: p,
    confidence,
    abstained: p === null,
    ...extra,
  });

  // weight, gold, prediction, and whether it is covered:
  // a 2 crypto      crypto 0.95          covered, right, incumbent right
  // b 4 tech_bug    tech_bug 0.9         covered, right
  // c 4 account     tech_bug 0.9         covered, wrong
  // d 4 account     account, ABSTAINED   not covered (even though account's threshold is 0)
  // e 1 crypto      crypto 0.5           not covered (below threshold)
  // f 4 moderation  moderation 0.99      not covered (no fitted threshold)
  // g 1 crypto      crypto exactly 0.9   covered, right, incumbent right; an earlier error row must not win
  // h 1 account     account, null conf   covered: a threshold of 0 covers everything, as the harness does
  // z   crypto      crypto 0.99          no weight: not a sampled item, excluded entirely
  const items = [
    item('a', 'crypto'),
    item('b', 'other'),
    item('c', 'technical_bug'),
    item('d', 'account'),
    item('e', 'crypto'),
    item('f', 'moderation'),
    item('g', 'crypto'),
    item('h', null),
    item('z', 'crypto'),
  ];
  const gold = new Map([
    ['a', 'crypto'],
    ['b', 'technical_bug'],
    ['c', 'account'],
    ['d', 'account'],
    ['e', 'crypto'],
    ['f', 'moderation'],
    ['g', 'crypto'],
    ['h', 'account'],
    ['z', 'crypto'],
  ]);
  const weights = new Map([
    ['a', 2],
    ['b', 4],
    ['c', 4],
    ['d', 4],
    ['e', 1],
    ['f', 4],
    ['g', 1],
    ['h', 1],
  ]);
  const predictions = [
    pred('a', 'crypto', 0.95),
    pred('b', 'technical_bug', 0.9),
    pred('c', 'technical_bug', 0.9),
    pred('d', 'account', 0.9, { abstained: true }),
    pred('e', 'crypto', 0.5),
    pred('f', 'moderation', 0.99),
    pred('g', null, null, { status: 'error' }),
    pred('g', 'crypto', 0.9),
    pred('h', 'account', null),
    pred('z', 'crypto', 0.99),
  ];
  const thresholds = { crypto: 0.9, technical_bug: 0.8, account: 0 };

  it('re-weights to the population, covering only fitted, confident, non-abstained answers', () => {
    const s = weightedSummary({ items, gold, predictions, weights, thresholds });
    expect(s.items).toBe(8);
    // covered weight a2 + b4 + c4 + g1 + h1 = 12 of 21 (unweighted would be 5/8)
    expect(s.coverage).toBeCloseTo(12 / 21, 10);
    // right: a2 + b4 + g1 + h1 = 8 of 12 (unweighted 4/5)
    expect(s.accuracyOnCovered).toBeCloseTo(8 / 12, 10);
    // incumbent on the same covered set: a2 + g1 = 3 of 12
    expect(s.incumbentAccuracyOnCovered).toBeCloseTo(3 / 12, 10);
  });

  it('treats a failed prediction as not covered', () => {
    const s = weightedSummary({
      items: [item('a', 'crypto')],
      gold,
      predictions: [pred('a', 'crypto', 0.99, { status: 'error' })],
      weights,
      thresholds,
    });
    expect(s.coverage).toBe(0);
    expect(s.accuracyOnCovered).toBeNull();
  });

  it('reads weights by header name and refuses one no inverse inclusion probability can be', () => {
    const sampler =
      'ticket_id,stratum,stratum_population,stratum_sampled,weight,double_labelled\r\n' +
      '1,crypto,50,20,2.5,0\r\n';
    expect([...parseStrataWeights(sampler)]).toEqual([['1', 2.5]]);
    expect([...parseStrataWeights('weight,ticket_id\n3,7\n')]).toEqual([['7', 3]]);
    expect(() => parseStrataWeights('ticket_id,weight\n1,0.5\n')).toThrow(/weight/);
    expect(() => parseStrataWeights('ticket_id,weight\n1,abc\n')).toThrow(/weight/);
    expect(() => parseStrataWeights('ticket_id,stratum\n1,x\n')).toThrow(/columns/);
  });
});

describe('support.topic split isolation', () => {
  it('drops a dev item whose requester is in test, keeping every test item', () => {
    const rows = [
      { itemId: 'd1', split: 'dev', groupKey: 'g1' },
      { itemId: 'd2', split: 'dev', groupKey: 'g2' },
      { itemId: 't1', split: 'test', groupKey: 'g1' },
      { itemId: 't2', split: 'test', groupKey: 'g3' },
    ];
    const { kept, dropped } = dropDevSharingTestGroup(rows);
    expect(kept.map((r) => r.itemId)).toEqual(['d2', 't1', 't2']);
    expect(dropped).toBe(1);
  });
});

describe('support.topic bar and gold policy', () => {
  it('holds the money topics to 0.90 and leaves every other class on the run target', () => {
    expect(supportTopicNode.targets).toEqual({
      billing_buzz: 0.9,
      crypto: 0.9,
      payment_refund: 0.9,
    });
  });

  it('makes the configured primary labeller gold, and falls back to majority without one', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'support-topic-'));
    const dir = join(dataDir, NODE_ID);
    mkdirSync(dir);
    const write = (cfg: object) => writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
    const base = { classifierVersion: 'v', testStrataFiles: ['s.csv'] };

    write({ ...base, primaryLabeler: 'labeller-a' });
    expect(supportTopicNode.goldPolicy?.({ dataDir })).toEqual({
      kind: 'primary',
      labeler: 'labeller-a',
    });
    write(base);
    expect(supportTopicNode.goldPolicy?.({ dataDir })).toEqual({ kind: 'majority' });
  });
});

describe('support.topic weighted thresholds', () => {
  it('takes only fitted classes from a thresholds file', () => {
    expect(
      fittedThresholds({
        fits: {
          crypto: { status: 'fitted', threshold: 0.6 },
          account: { status: 'no-threshold' },
          other: { status: 'insufficient-n', available: 3 },
        },
      })
    ).toEqual({ crypto: 0.6 });
    expect(() => fittedThresholds({})).toThrow(/no fits/);
  });
});

describe('support.topic source and gold against a fake ClickHouse', () => {
  type Q = { query: string; query_params?: Record<string, unknown> };
  const ticket = (id: string, requester: string, ms: number, extra: object = {}) => ({
    ticket_id: id,
    created_ms: String(ms),
    ticket_subject: 'subject',
    body_clean: 'body',
    conversation_tail: 'tail',
    member_tier: 'free',
    lang: 'en',
    topic: 'crypto',
    requester_freshdesk_id: requester,
    requester_email: 'someone@example.org',
    civitai_username: null,
    ...extra,
  });

  function setup(labels: object[], tickets: object[]) {
    const dataDir = mkdtempSync(join(tmpdir(), 'support-topic-src-'));
    const dir = join(dataDir, NODE_ID);
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ classifierVersion: 'v1', testStrataFiles: ['s.csv'] })
    );
    writeFileSync(join(dir, 's.csv'), 'weight,stratum,ticket_id\n2,crypto,500\n5,_rest,501\n');
    const queries: Q[] = [];
    clickhouse.createClient.mockImplementation(() => ({
      query: async (q: Q) => {
        queries.push(q);
        const rows = q.query.includes('support_ticket_eval_labels') ? labels : tickets;
        return { json: async () => rows };
      },
      close: async () => undefined,
    }));
    return { ctx: { dataDir }, queries };
  }

  async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const x of it) out.push(x);
    return out;
  }

  it('assigns strata tickets to test, labelled tickets to dev, and drops a dev ticket sharing a test requester', async () => {
    vi.stubEnv('CLICKHOUSE_HOST', 'http://127.0.0.1:1');
    const { ctx, queries } = setup(
      [
        { ticket_id: '100', label_topic: 'crypto', notes: '', labeler: 'h1' },
        { ticket_id: '101', label_topic: 'other', notes: '', labeler: 'h1' },
      ],
      [
        ticket('500', 'r-test', Date.UTC(2026, 8, 30, 23, 30), {
          civitai_username: 'PatCreator9',
          requester_email: 'pat.doe@example.org',
          body_clean: 'I am PatCreator9, also pat.doe on forums',
          conversation_tail: 'pat.doe here again, patcreator9',
        }),
        ticket('501', 'r-other', Date.UTC(2026, 7, 31, 23, 59)),
        ticket('100', 'r-test', Date.UTC(2026, 4, 1)),
        ticket('101', 'r-dev', Date.UTC(2026, 4, 2)),
      ]
    );
    const rows = await collect(supportTopicNode.source(ctx));
    expect(rows.map((r) => [r.itemId, r.split]).sort()).toEqual([
      ['101', 'dev'],
      ['500', 'test'],
      ['501', 'test'],
    ]);
    // The month comes from the epoch, never from local time.
    expect(rows.find((r) => r.itemId === '500')?.ts).toBe('2026-09-30T23:30:00.000Z');
    expect(rows.find((r) => r.itemId === '501')?.ts).toBe('2026-08-31T23:59:00.000Z');
    const keys = new Set(rows.map((r) => r.groupKey));
    expect(keys.size).toBe(3);
    const labelQuery = queries.find((q) => q.query.includes('support_ticket_eval_labels'));
    expect(labelQuery?.query).toMatch(/AND labeler NOT LIKE 'judge-%'\s*$/);
    expect(labelQuery?.query_params).toEqual({ cv: 'v1' });
    const ticketQuery = queries.find((q) => q.query.includes('support_tickets_classified'));
    expect(ticketQuery?.query_params?.cv).toBe('v1');
    expect([...(ticketQuery?.query_params?.ids as string[])].sort()).toEqual([
      '100',
      '101',
      '500',
      '501',
    ]);
    const t500 = rows.find((r) => r.itemId === '500');
    expect(supportTopicNode.slices?.(t500!.raw)?.stratum).toBe('crypto');
    // The requester's identifiers travel from the stored row into the redaction.
    const state = Object.values(supportTopicNode.buildState(t500!.raw)).join(' ').toLowerCase();
    expect(state).not.toContain('patcreator9');
    expect(state).not.toContain('pat.doe');
  });

  it('refuses when ClickHouse returns a duplicate in place of a missing ticket', async () => {
    vi.stubEnv('CLICKHOUSE_HOST', 'http://127.0.0.1:1');
    const { ctx } = setup([], [ticket('500', 'a', 0), ticket('500', 'a', 0)]);
    await expect(collect(supportTopicNode.source(ctx))).rejects.toThrow(/exactly one stored row/);
  });

  it('yields every labeller, keeps cannot-tell, and throws on an unknown label', async () => {
    vi.stubEnv('CLICKHOUSE_HOST', 'http://127.0.0.1:1');
    const ok = setup(
      [
        { ticket_id: '500', label_topic: 'billing-buzz', notes: '', labeler: 'h1' },
        { ticket_id: '500', label_topic: 'payment-refund', notes: '', labeler: 'h2' },
        { ticket_id: '501', label_topic: '', notes: 'cannot-tell: vague', labeler: 'h1' },
        { ticket_id: '502', label_topic: '', notes: 'later', labeler: 'h1' },
      ],
      []
    );
    expect(await collect(supportTopicNode.gold(ok.ctx))).toEqual([
      {
        itemId: '500',
        gold: 'billing_buzz',
        goldSource: 'support_ticket_eval_labels',
        labeler: 'h1',
      },
      {
        itemId: '500',
        gold: 'payment_refund',
        goldSource: 'support_ticket_eval_labels',
        labeler: 'h2',
      },
      { itemId: '501', gold: CANNOT_TELL, goldSource: 'support_ticket_eval_labels', labeler: 'h1' },
    ]);
    const bad = setup([{ ticket_id: '9', label_topic: 'billing', notes: '', labeler: 'h1' }], []);
    await expect(collect(supportTopicNode.gold(bad.ctx))).rejects.toThrow(/not an incumbent topic/);
  });

  it('slices dev items as dev, so a --period filter never picks them up', () => {
    expect(supportTopicNode.slices?.(raw({ stratum: undefined }))?.period).toBe('dev');
    expect(supportTopicNode.slices?.(raw())?.period).toBe('2026-09');
  });

  it('fails loudly without a config rather than quietly using majority', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'support-topic-nocfg-'));
    expect(() => supportTopicNode.goldPolicy?.({ dataDir })).toThrow(/config.json is missing/);
  });
});

describe('support.topic stored-row check', () => {
  it('refuses a duplicated ticket even when every wanted ticket is present', async () => {
    vi.stubEnv('CLICKHOUSE_HOST', 'http://127.0.0.1:1');
    const dataDir = mkdtempSync(join(tmpdir(), 'support-topic-dup-'));
    mkdirSync(join(dataDir, NODE_ID));
    writeFileSync(
      join(dataDir, NODE_ID, 'config.json'),
      JSON.stringify({ classifierVersion: 'v1', testStrataFiles: ['s.csv'] })
    );
    writeFileSync(join(dataDir, NODE_ID, 's.csv'), 'ticket_id,stratum\n500,crypto\n');
    const row = {
      ticket_id: '500',
      created_ms: '0',
      requester_freshdesk_id: 'a',
      requester_email: '',
    };
    clickhouse.createClient.mockImplementation(() => ({
      query: async (q: { query: string }) => ({
        json: async () => (q.query.includes('support_ticket_eval_labels') ? [] : [row, row]),
      }),
      close: async () => undefined,
    }));
    const drain = async () => {
      for await (const _ of supportTopicNode.source({ dataDir })) void _;
    };
    await expect(drain()).rejects.toThrow(/exactly one stored row/);
  });
});

describe('support.topic source guards', () => {
  const t = (id: string) => ({
    ticket_id: id,
    created_ms: '0',
    requester_freshdesk_id: 'r' + id,
    requester_email: '',
  });
  function fresh(tickets: object[]) {
    const dataDir = mkdtempSync(join(tmpdir(), 'support-topic-guard-'));
    mkdirSync(join(dataDir, NODE_ID));
    writeFileSync(
      join(dataDir, NODE_ID, 'config.json'),
      JSON.stringify({ classifierVersion: 'v1', testStrataFiles: ['s.csv'] })
    );
    writeFileSync(join(dataDir, NODE_ID, 's.csv'), 'ticket_id,stratum\n500,crypto\n501,_rest\n');
    clickhouse.createClient.mockImplementation(() => ({
      query: async (q: { query: string }) => ({
        json: async () => (q.query.includes('support_ticket_eval_labels') ? [] : tickets),
      }),
      close: async () => undefined,
    }));
    return { dataDir };
  }
  async function drain(ctx: { dataDir: string }) {
    const out: { groupKey: string }[] = [];
    for await (const r of supportTopicNode.source(ctx)) out.push(r);
    return out;
  }

  it.each([
    ['an extra ticket beside every wanted one', ['500', '501', '999']],
    ['a substituted ticket with the same count', ['500', '999']],
  ])('refuses %s', async (_, ids) => {
    vi.stubEnv('CLICKHOUSE_HOST', 'http://127.0.0.1:1');
    await expect(drain(fresh(ids.map(t)))).rejects.toThrow(/exactly one stored row/);
  });

  it('keeps the salt across builds, and refuses to regenerate it once a manifest exists', async () => {
    vi.stubEnv('CLICKHOUSE_HOST', 'http://127.0.0.1:1');
    const ctx = fresh(['500', '501'].map(t));
    const first = (await drain(ctx)).map((r) => r.groupKey);
    expect((await drain(ctx)).map((r) => r.groupKey)).toEqual(first);
    rmSync(join(ctx.dataDir, NODE_ID, 'group-salt'));
    writeFileSync(join(ctx.dataDir, NODE_ID, 'manifest.jsonl'), '');
    await expect(drain(ctx)).rejects.toThrow(/restore the salt/);
  });

  it('reads the strata stratum by header name, and refuses a file without one', () => {
    expect([...parseStrataCsv('stratum,x,ticket_id\ncrypto,1,500\n')]).toEqual([['500', 'crypto']]);
    expect(() => parseStrataCsv('ticket_id,x\n500,1\n')).toThrow(/columns/);
  });

  it('redacts a base58 address but not a long ordinary word', () => {
    expect(redact('send to 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU now')).toBe(
      'send to [id] now'
    );
    expect(redact('pneumonoultramicroscopicsilicovolcanoconiosis')).toBe(
      'pneumonoultramicroscopicsilicovolcanoconiosis'
    );
  });

  it('weighted summary skips a sampled item with no gold', () => {
    const s = weightedSummary({
      items: [
        { itemId: 'a', groupKey: 'a', ts: '', split: 'test', state: {} },
        { itemId: 'b', groupKey: 'b', ts: '', split: 'test', state: {} },
      ],
      gold: new Map([['a', 'crypto']]),
      predictions: [
        { itemId: 'a', runKey: 'k', status: 'ok', pred: 'other', confidence: 1, abstained: false },
        { itemId: 'b', runKey: 'k', status: 'ok', pred: 'crypto', confidence: 1, abstained: false },
      ],
      weights: new Map([
        ['a', 1],
        ['b', 9],
      ]),
      thresholds: { crypto: 0.5, other: 0.5 },
    });
    expect(s).toEqual({
      items: 1,
      coverage: 1,
      accuracyOnCovered: 0,
      incumbentAccuracyOnCovered: 0,
    });
  });
});

describe('support.topic redaction window', () => {
  it('leaves text within the window untouched', () => {
    expect(redactionWindow('short text', 6000, false)).toBe('short text');
  });

  it('cuts the head at whitespace so no identifier is split', () => {
    // The email straddles the 7000-character window edge.
    const text = 'w '.repeat(3495) + 'jo.smith@another.net ' + 'z '.repeat(100);
    const head = redactionWindow(text, 6000, false);
    expect(head.length).toBeLessThanOrEqual(7000);
    expect(head.endsWith('w') || head.endsWith('z') || head.endsWith('net')).toBe(true);
    expect(head).not.toMatch(/\S+@\S*$/);
  });

  it('starts the tail after whitespace so no identifier is split', () => {
    // The email straddles the 4000-character window edge.
    const text = 'jo.smith@another.net ' + 'y '.repeat(1995);
    const tail = redactionWindow(text, 3000, true);
    expect(tail.length).toBeLessThanOrEqual(4000);
    expect(tail.startsWith('y')).toBe(true);
  });

  it('drops a window that is one unbroken token rather than cutting it', () => {
    expect(redactionWindow('x'.repeat(10_000), 6000, false)).toBe('');
  });

  it('keeps redaction time bounded on a long run no pattern matches', () => {
    // Several patterns are quadratic here; unbounded, 32k characters takes several seconds.
    // Spaced so each window keeps ~7k characters of the slow shape, rather than collapsing to ''.
    const run = ('a.'.repeat(3400) + ' ').repeat(5);
    const started = performance.now();
    buildSupportState(raw({ subject: run, firstMessage: run, latestMessages: run }));
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('redacts a bech32 wallet address', () => {
    expect(redact('sent from bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq ok')).toBe(
      'sent from [id] ok'
    );
  });
});

describe('support.topic final cut', () => {
  it('re-redacts after the tail cut, which can itself start a handle', () => {
    const state = buildSupportState(
      raw({ latestMessages: 'earlier text, ask me@discord ' + 'y '.repeat(1495) + 'y' })
    );
    expect(() => assertNoPii('x', state)).not.toThrow();
    expect(state.latest_messages.startsWith('[handle]')).toBe(true);
  });

  it('cuts text without spaces at a script boundary instead of dropping it', () => {
    const cjk = '問'.repeat(8000);
    const state = buildSupportState(raw({ firstMessage: 'Hello\n' + cjk, latestMessages: cjk }));
    expect(state.first_message.length).toBe(6000);
    expect(state.latest_messages.length).toBe(3000);
  });
});
