import { describe, expect, it } from 'vitest';

import { NODES } from '../decision-eval/nodes';
import {
  buildSupportState,
  CANNOT_TELL,
  dropDevSharingTestGroup,
  goldFromLabel,
  groupKeyFor,
  HUMAN_LABELS_SQL,
  INCUMBENT_TOPIC_MAP,
  keywordBaseline,
  NODE_ID,
  parseStrataCsv,
  periodOf,
  redact,
  supportTopicNode,
  TOPIC_CLASSES,
  type SupportTicketRaw,
} from '../decision-eval/nodes/support-topic';
import { assertNoPii } from '../decision-eval/safety';
import { parseStrataWeights, weightedSummary } from '../decision-eval/nodes/support-topic-weighted';
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
    subject: 'Help for pat.doe@example.org',
    firstMessage:
      'Hi, I am PatTheCreator (pat.doe on discord). Mail me at pat.doe@example.org or cc my friend jo.smith@another.net, or see https://civitai.com/user/PatTheCreator and www.example.com, ping @mod_team.',
    latestMessages: 'Still waiting @support_lead',
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
    expect(all).not.toContain('patthecreator');
    expect(all).not.toContain('pat.doe');
    expect(all).not.toContain('another.net');
  });

  it('sends only the fields the question needs: no incumbent answer, no requester ids', () => {
    expect(Object.keys(buildSupportState(raw())).sort()).toEqual(
      ['first_message', 'latest_messages', 'member_tier', 'subject'].sort()
    );
  });

  it('keeps the start of the first message and the end of the thread', () => {
    const state = buildSupportState(
      raw({
        firstMessage: `HEAD${'x'.repeat(10_000)}`,
        latestMessages: `${'y'.repeat(10_000)}TAIL`,
      })
    );
    expect(state.first_message.startsWith('HEAD')).toBe(true);
    expect(state.first_message.length).toBe(6000);
    expect(state.latest_messages.endsWith('TAIL')).toBe(true);
    expect(state.latest_messages.length).toBe(3000);
  });

  it('does not treat a short or empty username as something to strip', () => {
    expect(redact('a b c', ['', ' ', 'ab'])).toBe('a b c');
  });
});

describe('support.topic labels', () => {
  it('maps every incumbent slug onto a real topic class, never onto cannot_tell', () => {
    expect(Object.keys(INCUMBENT_TOPIC_MAP)).toHaveLength(13);
    for (const v of Object.values(INCUMBENT_TOPIC_MAP)) {
      expect(TOPIC_CLASSES).toContain(v);
      expect(v).not.toBe(CANNOT_TELL);
    }
  });

  it.each([
    ['nsfw-moderation', '', 'moderation'],
    ['image-moderation-appeal', '', 'moderation'],
    ['account-issue', '', 'account'],
    ['mobile-app', '', 'technical_bug'],
    ['', 'cannot-tell', CANNOT_TELL],
    ['', 'cannot-tell: asks two things', CANNOT_TELL],
    ['', 'come back later', null],
    ['not-a-topic', '', null],
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
      '101,crypto,160,60,2.666667,0\r\n102,_rest,1085,133,8.157895,1\r\n';
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
    confidence: number,
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

  // a: oversampled crypto (w=1), right; b: rest (w=4), right; c: rest (w=4), wrong;
  // d: abstained (w=4); e: below threshold (w=1); f: class with no fitted threshold (w=4).
  const items = [
    item('a', 'crypto'),
    item('b', 'other'),
    item('c', 'technical_bug'),
    item('d', 'account'),
    item('e', 'crypto'),
    item('f', 'moderation'),
  ];
  const gold = new Map([
    ['a', 'crypto'],
    ['b', 'technical_bug'],
    ['c', 'account'],
    ['d', 'account'],
    ['e', 'crypto'],
    ['f', 'moderation'],
  ]);
  const weights = new Map([
    ['a', 1],
    ['b', 4],
    ['c', 4],
    ['d', 4],
    ['e', 1],
    ['f', 4],
  ]);
  const predictions = [
    pred('a', 'crypto', 0.95),
    pred('b', 'technical_bug', 0.9),
    pred('c', 'technical_bug', 0.9),
    pred('d', null, 0.9),
    pred('e', 'crypto', 0.5),
    pred('f', 'moderation', 0.99),
  ];
  const thresholds = { crypto: 0.9, technical_bug: 0.8 };

  it('re-weights coverage and accuracy to the population, covering only fitted, confident, non-abstained answers', () => {
    const s = weightedSummary({ items, gold, predictions, weights, thresholds });
    expect(s.items).toBe(6);
    // covered: a (1) + b (4) + c (4) = 9 of 18
    expect(s.coverage).toBeCloseTo(9 / 18, 10);
    // correct among covered: a (1) + b (4) = 5 of 9; unweighted would be 2/3
    expect(s.accuracyOnCovered).toBeCloseTo(5 / 9, 10);
    // incumbent on the same covered set: a right (1), b wrong, c wrong
    expect(s.incumbentAccuracyOnCovered).toBeCloseTo(1 / 9, 10);
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

  it('refuses a weight below 1, which no inverse inclusion probability can be', () => {
    expect(() => parseStrataWeights('ticket_id,stratum,weight\n1,crypto,0.5\n')).toThrow(/weight/);
    expect([...parseStrataWeights('ticket_id,stratum,weight\r\n1,crypto,2.5\r\n')]).toEqual([
      ['1', 2.5],
    ]);
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

describe('support.topic gold source', () => {
  it('reads human labels only: the LLM judge rows are silver and must never become gold', () => {
    expect(HUMAN_LABELS_SQL).toMatch(/AND labeler NOT LIKE 'judge-%'/);
  });
});
