import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { main } from '../decision-eval/cli';
import { NODES, registerNode, type NodeSpec } from '../decision-eval/nodes';
import { choiceMapper } from '../decision-eval/runner';

/**
 * The CLI end to end against a stubbed imajev server: build, incremental run,
 * score with controls, the sealed test, and the training-manifest refusal.
 */

type Raw = { text: string; truth: 'x' | 'y'; split: 'dev' | 'test' };

const ROWS: Array<{ itemId: string; raw: Raw }> = Array.from({ length: 60 }, (_, i) => ({
  itemId: `t${i}`,
  raw: { text: `ticket ${i}`, truth: i % 2 ? 'x' : 'y', split: i < 40 ? 'dev' : 'test' },
}));
let rows = ROWS.slice(0, 50);
const excludeIds = new Set<string>();
const relabel = new Map<string, 'x' | 'y'>();

const node: NodeSpec<Raw> = {
  id: 'test.topic',
  specVersion: 1,
  dataClass: 'public-text',
  classes: ['x', 'y'],
  targets: { x: 0.9 },
  formats: {
    A: {
      questions: [
        {
          id: 'topic',
          type: 'choice',
          instructions: 'Which topic?',
          options: [
            { key: 'x', description: 'topic x' },
            { key: 'y', description: 'topic y' },
          ],
        },
      ],
      mapAnswer: choiceMapper('topic'),
    },
  },
  buildState: (raw) => ({ text: raw.text, hint: raw.truth }),
  slices: (raw) => ({ parity: raw.truth }),
  baselines: (raw) => ({ incumbent: raw.truth === 'x' ? 'x' : null }),
  exclude: (raw) => (excludeIds.has(raw.text.replace('ticket ', 't')) ? 'reported' : null),
  async *source() {
    for (const r of rows) {
      yield {
        itemId: r.itemId,
        groupKey: `g-${r.itemId}`,
        ts: '2026-09-20T00:00:00Z',
        raw: r.raw,
        split: r.raw.split,
      };
    }
  },
  async *gold() {
    for (const r of rows) {
      const gold = relabel.get(r.itemId) ?? r.raw.truth;
      yield { itemId: r.itemId, gold, goldSource: 'test', labeler: 'lead' };
    }
  },
};

const calls: string[] = [];

function imajevStub() {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse((init?.body as FormData).get('request') as string);
    const [qid] = Object.keys(request.questions);
    const choice = qid === 'paid' ? 'paid' : request.state.hint;
    calls.push(qid);
    const keys = Object.keys(request.questions[qid].criteria);
    const probabilities = Object.fromEntries(
      keys.map((k) => [k, k === choice ? 0.95 : 0.05 / (keys.length - 1)])
    );
    return new Response(
      JSON.stringify({
        model: 'imajev-4b',
        answers: {
          [qid]: {
            type: 'choice',
            choice,
            probabilities,
            confidence: 0.95,
            unknown_probability: 0,
            abstained: false,
          },
        },
      }),
      { status: 200 }
    );
  });
}

let dataDir: string;
const arm = [
  '--model',
  'imajev',
  '--imajev-url',
  'http://127.0.0.1:8765',
  '--imajev-model-name',
  'imajev-4b',
  '--adapter-sha256',
  'abc',
  '--rotations',
  '4',
  '--hardware',
  'test',
];
const nodeArgs = () => ['--node', 'test.topic', '--data-dir', dataDir];
const root = () => join(dataDir, 'test.topic');
const readLines = (path: string) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'decision-eval-cli-'));
  registerNode(node);
  vi.stubGlobal('fetch', imajevStub());
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterAll(() => {
  delete (NODES as Record<string, unknown>)[node.id];
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('decision-eval CLI', () => {
  it('builds a manifest, gold and a v1 eval index', async () => {
    await main(['build', ...nodeArgs()]);
    expect(readLines(join(root(), 'manifest.jsonl'))).toHaveLength(50);
    const index = JSON.parse(readFileSync(join(root(), 'eval-index.v1.json'), 'utf8'));
    expect(index).toMatchObject({
      schema: 'civitai.decision-eval.eval-index',
      version: 1,
      nodeId: 'test.topic',
    });
    expect(index.itemIds).toHaveLength(50);
  });

  it('🔴 a daily rebuild appends new items and keeps the old ones when the source drops them', async () => {
    rows = ROWS.slice(10);
    await main(['build', ...nodeArgs()]);
    const ids = readLines(join(root(), 'manifest.jsonl')).map((i: { itemId: string }) => i.itemId);
    expect(ids).toHaveLength(60);
    expect(ids).toContain('t0');
  });

  it('🔴 runs the known-answer control first, then only items not yet predicted', async () => {
    calls.length = 0;
    await main(['run', ...nodeArgs(), '--format', 'A', '--split', 'dev', ...arm]);
    expect(calls[0]).toBe('paid');
    expect(calls.filter((c) => c === 'topic')).toHaveLength(40);

    calls.length = 0;
    await main(['run', ...nodeArgs(), '--format', 'A', '--split', 'dev', ...arm]);
    expect(calls).toEqual(['paid']);
  });

  it('scores dev with the planted-flip control and baselines in the report', async () => {
    await main([
      'score',
      ...nodeArgs(),
      '--format',
      'A',
      '--split',
      'dev',
      '--target',
      '0.8',
      ...arm,
    ]);
    const runs = join(root(), 'runs');
    const [key] = readdirSync(runs);
    const report = readFileSync(join(runs, key, 'report-dev.md'), 'utf8');
    expect(report).toContain('planted flipped labels: 20 planted on dev; 20 became errors');
    expect(report).toContain('| model | 40 | 0 | 0 | 0 | 40 |');
    expect(report).toContain('baseline: incumbent');
    expect(report).toContain('## Slice: parity');
    expect(report).toMatch(/^- hardware: test$/m);
    expect(report).toContain(
      '| run | items | missing | refused | errors | answered | abstained | accuracy | kappa | ECE |'
    );
    const thresholds = JSON.parse(readFileSync(join(runs, key, 'thresholds-dev.json'), 'utf8'));
    expect(thresholds.targets).toEqual({ x: 0.9, y: 0.8 });
    expect(Object.keys(thresholds.fits).sort()).toEqual(['x', 'y']);
    expect(() => registerNode(node)).toThrow('already registered');
  });

  it('🔴 refuses to score without a recorded known-answer control for the run', async () => {
    await expect(
      main([
        'score',
        ...nodeArgs(),
        '--format',
        'A',
        '--split',
        'dev',
        '--target',
        '0.8',
        ...arm,
        '--rotations',
        '1',
      ])
    ).rejects.toThrow('no passing known-answer control recorded');
  });

  it('🔴 a score that fails its controls does not consume the sealed test', async () => {
    await expect(
      main(['score', ...nodeArgs(), '--format', 'A', '--split', 'test', '--target', '0.8', ...arm])
    ).rejects.toThrow('proved nothing');
    expect(existsSync(join(root(), 'sealed-test.json'))).toBe(false);
  });

  it('🔴 scores the sealed test once, and refuses a second time without a reason', async () => {
    await main(['run', ...nodeArgs(), '--format', 'A', '--split', 'test', ...arm]);
    await main([
      'score',
      ...nodeArgs(),
      '--format',
      'A',
      '--split',
      'test',
      '--target',
      '0.8',
      ...arm,
    ]);
    await expect(
      main(['score', ...nodeArgs(), '--format', 'A', '--split', 'test', '--target', '0.8', ...arm])
    ).rejects.toThrow('sealed test was already scored');
    await main([
      'score',
      ...nodeArgs(),
      '--format',
      'A',
      '--split',
      'test',
      '--target',
      '0.8',
      ...arm,
      '--reseal-reason',
      'spec typo',
    ]);
    const sealed = JSON.parse(readFileSync(join(root(), 'sealed-test.json'), 'utf8'));
    expect(sealed.map((e: { reason: string | null }) => e.reason)).toEqual([null, 'spec typo']);
    const runs = join(root(), 'runs');
    const report = readFileSync(join(runs, readdirSync(runs)[0], 'report-test.md'), 'utf8');
    expect(report).toContain('planted on test');
    expect(report).toContain('sealed test scored 1 time(s) before this report');
  });

  it('🔴 a corrected label replaces the old one on rebuild instead of adding a second vote', async () => {
    relabel.set('t12', 'x');
    await main(['build', ...nodeArgs()]);
    relabel.clear();
    const rows12 = readLines(join(root(), 'gold.jsonl')).filter(
      (r: { itemId: string }) => r.itemId === 't12'
    );
    expect(rows12).toEqual([{ itemId: 't12', gold: 'x', goldSource: 'test', labeler: 'lead' }]);
  });

  it('🔴 an item excluded after it was sampled leaves the manifest and stays out', async () => {
    excludeIds.add('t11');
    await main(['build', ...nodeArgs()]);
    excludeIds.clear();
    await main(['build', ...nodeArgs()]);
    const ids = readLines(join(root(), 'manifest.jsonl')).map((i: { itemId: string }) => i.itemId);
    expect(ids).not.toContain('t11');
    expect(ids).toHaveLength(59);
  });

  it('🔴 refuses a training manifest that contains an excluded item', async () => {
    const candidates = join(dataDir, 'excluded-candidates.jsonl');
    writeFileSync(
      candidates,
      `${JSON.stringify({
        itemId: 't11',
        groupKey: 'g-other',
        ts: '2026-08-01T00:00:00Z',
        state: {},
        partition: 'train',
      })}
`
    );
    await expect(
      main(['train-manifest', ...nodeArgs(), '--candidates', candidates])
    ).rejects.toThrow('are excluded items');
  });

  it('🔴 refuses a training manifest that contains an eval item', async () => {
    const candidates = join(dataDir, 'candidates.jsonl');
    writeFileSync(
      candidates,
      `${JSON.stringify({
        itemId: 't5',
        groupKey: 'g-new',
        ts: '2026-08-01T00:00:00Z',
        state: {},
        partition: 'trainer-dev',
      })}\n`
    );
    await expect(
      main(['train-manifest', ...nodeArgs(), '--candidates', candidates])
    ).rejects.toThrow('collide with the eval index');
    expect(existsSync(join(root(), 'train-manifest.jsonl'))).toBe(false);
  });

  it('🔴 refuses a training manifest row whose id is not a string, rather than reporting no collisions', async () => {
    const candidates = join(dataDir, 'numeric-candidates.jsonl');
    writeFileSync(
      candidates,
      `${JSON.stringify({
        itemId: 7,
        groupKey: 'g-new',
        ts: '2026-08-01T00:00:00Z',
        state: {},
        partition: 'train',
      })}\n`
    );
    await expect(
      main(['train-manifest', ...nodeArgs(), '--candidates', candidates])
    ).rejects.toThrow('training row 1: itemId must be a non-empty string');
    expect(existsSync(join(root(), 'train-manifest.jsonl'))).toBe(false);
  });

  it('refuses a data dir inside this repository', async () => {
    await expect(
      main(['build', '--node', 'test.topic', '--data-dir', join(__dirname, 'x')])
    ).rejects.toThrow('inside the git checkout');
  });
});
