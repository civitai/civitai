import { describe, expect, it } from 'vitest';

import {
  buildEvalIndex,
  buildTrainManifest,
  enforceGroupIsolation,
  LeakageError,
  mergeGold,
  mergeManifest,
  parseEvalIndex,
  resolveGold,
  serializeEvalIndex,
  timeSplit,
  type TrainCandidate,
} from '../decision-eval/builder';
import type { ManifestItem, Split } from '../decision-eval/types';

const item = (itemId: string, groupKey: string, split: Split): ManifestItem => ({
  itemId,
  groupKey,
  ts: '2026-09-01T00:00:00Z',
  split,
  state: {},
});

describe('timeSplit', () => {
  const now = new Date('2026-10-03T00:00:00Z');
  it('train before day -30, dev -30 to -15, test from -15', () => {
    expect(timeSplit('2026-09-02T23:59:59Z', now)).toBe('train');
    expect(timeSplit('2026-09-03T00:00:00Z', now)).toBe('dev');
    expect(timeSplit('2026-09-17T23:59:59Z', now)).toBe('dev');
    expect(timeSplit('2026-09-18T00:00:00Z', now)).toBe('test');
  });
});

describe('enforceGroupIsolation', () => {
  const items = [item('1', 'u1', 'dev'), item('2', 'u1', 'test'), item('3', 'u2', 'test')];

  it('refuses a group that spans two splits', () => {
    expect(() => enforceGroupIsolation(items)).toThrow(LeakageError);
  });

  it('keeps the earliest split and returns what it dropped', () => {
    const r = enforceGroupIsolation(items, { dropLaterOverlap: true });
    expect(r.items.map((i) => i.itemId)).toEqual(['1', '3']);
    expect(r.dropped).toEqual([{ itemId: '2', groupKey: 'u1', split: 'test' }]);
  });
});

describe('mergeManifest — the rolling daily build', () => {
  it('🔴 never re-splits an item it already assigned', () => {
    const existing = [item('1', 'u1', 'test')];
    const incoming = [{ ...item('1', 'u1', 'dev'), state: { changed: 'yes' } }];
    const r = mergeManifest(existing, incoming);
    expect(r.items).toEqual(existing);
    expect(r.added).toBe(0);
  });

  it('keeps items the source no longer returns', () => {
    const r = mergeManifest([item('gone', 'u9', 'dev')], [item('new', 'u1', 'test')]);
    expect(r.items.map((i) => i.itemId)).toEqual(['gone', 'new']);
  });

  it('refuses a new item whose group already sits in another split', () => {
    expect(() => mergeManifest([item('1', 'u1', 'dev')], [item('2', 'u1', 'test')])).toThrow(
      LeakageError
    );
    const r = mergeManifest([item('1', 'u1', 'dev')], [item('2', 'u1', 'test')], {
      dropConflicts: true,
    });
    expect(r.dropped.map((d) => d.itemId)).toEqual(['2']);
    expect(r.items.map((i) => i.itemId)).toEqual(['1']);
  });
});

describe('buildTrainManifest — the leakage control', () => {
  const index = buildEvalIndex([item('e1', 'g-eval', 'dev'), item('t1', 'g-train', 'train')]);
  const candidate = (itemId: string, groupKey: string, partition: TrainCandidate['partition']) => ({
    itemId,
    groupKey,
    ts: '2026-08-01T00:00:00Z',
    state: {},
    partition,
  });

  it('indexes only eval splits', () => {
    expect(index).toEqual({ itemIds: ['e1'], groupKeys: ['g-eval'] });
  });

  it('🔴 refuses a planted eval id', () => {
    expect(() => buildTrainManifest([candidate('e1', 'other', 'train')], index)).toThrow(
      /1 training row\(s\) collide with the eval index \(first: item e1/
    );
  });

  it('🔴 refuses an eval id hidden in the trainer-dev partition', () => {
    expect(() => buildTrainManifest([candidate('e1', 'other', 'trainer-dev')], index)).toThrow(
      /partition trainer-dev/
    );
  });

  it('🔴 refuses a row from an eval GROUP even under a new item id', () => {
    expect(() => buildTrainManifest([candidate('fresh', 'g-eval', 'train')], index)).toThrow(
      LeakageError
    );
  });

  it.each([
    ['a numeric item id', { itemId: 7 }, 'itemId must be a non-empty string'],
    ['an empty item id', { itemId: '' }, 'itemId must be a non-empty string'],
    ['a numeric group key', { groupKey: 7 }, 'groupKey must be a non-empty string'],
    ['an empty group key', { groupKey: '' }, 'groupKey must be a non-empty string'],
    ['an unknown partition', { partition: 'dev' }, 'partition must be train or trainer-dev'],
    ['a non-string state', { state: { n: 1 } }, 'state must be an object of strings'],
    ['a null state', { state: null }, 'state must be an object of strings'],
    ['an array state', { state: ['a'] }, 'state must be an object of strings'],
  ])('🔴 refuses a row with %s, which Set.has could never match', (_, over, message) => {
    const row = { ...candidate('t9', 'g9', 'train'), ...over } as unknown as TrainCandidate;
    expect(() => buildTrainManifest([row], index)).toThrow(`training row 1: ${message}`);
  });

  it.each([
    ['id', candidate('someone@example.com', 'g9', 'train')],
    ['group_key', candidate('t9', 'someone@example.com', 'train')],
  ])('🔴 refuses a PII-shaped %s before any refusal that names an item', (field, row) => {
    // Also in the index and excluded, so a refusal naming the item would echo it if this came second.
    const run = () =>
      buildTrainManifest([row], { itemIds: [row.itemId], groupKeys: [row.groupKey] }, [row.itemId]);
    expect(run).toThrow(
      `training row 1: its ${field} is email-shaped; a node's ids must not carry personal data`
    );
    expect(run).not.toThrow(/someone@example\.com/);
  });

  it('builds when nothing collides', () => {
    const rows = [candidate('t1', 'g-train', 'train'), candidate('t2', 'g-train', 'trainer-dev')];
    expect(buildTrainManifest(rows, index)).toEqual(rows);
  });

  it('the index only grows: an id that was once eval stays eval', () => {
    const later = buildEvalIndex([item('e2', 'g2', 'test')], index);
    expect(later.itemIds).toEqual(['e1', 'e2']);
  });
});

describe('eval index file (v1, read by the LoRA builder)', () => {
  const index = { itemIds: ['e1'], groupKeys: ['g1'] };
  const file = serializeEvalIndex('support.topic', index, new Date('2026-10-03T00:00:00Z'));

  it('round-trips', () => {
    expect(file).toEqual({
      schema: 'civitai.decision-eval.eval-index',
      version: 1,
      nodeId: 'support.topic',
      updatedAt: '2026-10-03T00:00:00.000Z',
      itemIds: ['e1'],
      groupKeys: ['g1'],
    });
    expect(parseEvalIndex(JSON.parse(JSON.stringify(file)), 'support.topic')).toEqual(index);
  });

  it.each([
    ['another node', { ...file, nodeId: 'mod.minor' }],
    ['another version', { ...file, version: 2 }],
    ['a non-string id', { ...file, itemIds: [1] }],
    ['a missing list', { ...file, groupKeys: undefined }],
  ])('🔴 refuses an index for %s', (_, bad) => {
    expect(() => parseEvalIndex(bad, 'support.topic')).toThrow(LeakageError);
  });
});

describe('mergeGold — a rebuild must not keep a corrected label', () => {
  it("🔴 a labeller's new label for an item replaces their old one", () => {
    const merged = mergeGold(
      [{ itemId: 'a', gold: 'x', goldSource: 's', labeler: 'lead' }],
      [{ itemId: 'a', gold: 'y', goldSource: 's', labeler: 'lead' }]
    );
    expect(merged).toEqual([{ itemId: 'a', gold: 'y', goldSource: 's', labeler: 'lead' }]);
    expect(resolveGold(merged, { kind: 'primary', labeler: 'lead' }).gold.get('a')).toBe('y');
  });

  it("keeps rows the source no longer yields, and other labellers' rows", () => {
    const merged = mergeGold(
      [
        { itemId: 'gone', gold: 'x', goldSource: 's', labeler: 'lead' },
        { itemId: 'a', gold: 'x', goldSource: 's', labeler: 'second' },
      ],
      [{ itemId: 'a', gold: 'y', goldSource: 's', labeler: 'lead' }]
    );
    expect(merged.map((r) => `${r.itemId}:${r.labeler}:${r.gold}`).sort()).toEqual([
      'a:lead:y',
      'a:second:x',
      'gone:lead:x',
    ]);
  });

  it('does not let an item id containing a colon collide with another item and labeller', () => {
    const merged = mergeGold(
      [{ itemId: 'a:b', gold: 'x', goldSource: 's', labeler: 'c' }],
      [{ itemId: 'a', gold: 'y', goldSource: 's', labeler: 'b:c' }]
    );
    expect(merged).toHaveLength(2);
  });

  it('keeps several unattributed rows for one item, since they are separate votes', () => {
    const rows = [
      { itemId: 'a', gold: 'x', goldSource: 's1' },
      { itemId: 'a', gold: 'y', goldSource: 's2' },
    ];
    expect(mergeGold(rows, rows)).toEqual(rows);
  });
});

describe('resolveGold', () => {
  const pair = [
    { itemId: 'd', gold: 'x', goldSource: 's', labeler: 'lead' },
    { itemId: 'd', gold: 'y', goldSource: 's', labeler: 'second' },
  ];

  it('🔴 a primary labeller resolves the two-labeller disagreement majority vote would drop', () => {
    expect(resolveGold(pair).ties).toEqual(['d']);
    const r = resolveGold(pair, { kind: 'primary', labeler: 'lead' });
    expect(r.gold.get('d')).toBe('x');
    expect(r.ties).toEqual([]);
    expect(r.humanPairs).toEqual([['x', 'y']]);
  });

  it('🔴 disagreement can be its own gold class', () => {
    const r = resolveGold(pair, { kind: 'disagreement-as', label: 'cannot_tell' });
    expect(r.gold.get('d')).toBe('cannot_tell');
  });

  it('takes the majority, drops ties, and keeps human pairs', () => {
    const r = resolveGold([
      { itemId: 'a', gold: 'x', goldSource: 's', labeler: '1' },
      { itemId: 'a', gold: 'x', goldSource: 's', labeler: '2' },
      { itemId: 'a', gold: 'y', goldSource: 's', labeler: '3' },
      { itemId: 'b', gold: 'x', goldSource: 's', labeler: '1' },
      { itemId: 'b', gold: 'y', goldSource: 's', labeler: '2' },
      { itemId: 'c', gold: 'y', goldSource: 's', firstHumanLabel: 'x' },
    ]);
    expect([...r.gold]).toEqual([
      ['a', 'x'],
      ['c', 'y'],
    ]);
    expect(r.ties).toEqual(['b']);
    expect(r.humanPairs).toEqual([
      ['x', 'x'],
      ['x', 'y'],
    ]);
    expect(r.firstVsFinal).toEqual([['x', 'y']]);
  });
});
