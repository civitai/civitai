import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { main } from '../decision-eval/cli';
import { solidPng } from '../decision-eval/controls';
import { NODES, registerNode, type NodeSpec } from '../decision-eval/nodes';
import { choiceMapper } from '../decision-eval/runner';

/**
 * The moderation-image path end to end: the image known-answer control, images
 * fetched through the real HttpImageSource, a deleted image recorded as missing,
 * and the host rule for moderation images.
 */

type Raw = { id: string; verdict: 'allow' | 'block'; gone?: boolean; reported?: boolean };

const ROWS: Raw[] = Array.from({ length: 30 }, (_, i) => ({
  id: `m${i}`,
  verdict: i % 2 ? 'block' : 'allow',
  gone: i === 3,
  reported: i === 4,
}));
const IMAGE = solidPng(4, 4, [10, 10, 10]);
const reportedLater = new Set<string>();

const node: NodeSpec<Raw> = {
  id: 'test.moderation',
  specVersion: 1,
  dataClass: 'moderation-image',
  classes: ['allow', 'block'],
  formats: {
    A: {
      questions: [
        {
          id: 'verdict',
          type: 'choice',
          instructions: 'Allow or block?',
          options: [
            { key: 'allow', description: 'fine' },
            { key: 'block', description: 'breaks the rule' },
          ],
        },
      ],
      mapAnswer: choiceMapper('verdict'),
    },
  },
  buildState: (raw) => ({ hint: raw.verdict }),
  imageRefs: (raw) => [{ url: `https://images.internal/${raw.gone ? 'gone' : raw.id}` }],
  exclude: (raw) => (raw.reported ? 'csam-reported' : null),
  async *excludedIds() {
    yield* reportedLater;
  },
  async *source() {
    for (const raw of ROWS) {
      yield {
        itemId: raw.id,
        groupKey: raw.id,
        ts: '2026-10-01T00:00:00Z',
        raw,
        split: 'dev' as const,
      };
    }
  },
  async *gold() {
    for (const raw of ROWS) yield { itemId: raw.id, gold: raw.verdict, goldSource: 'test' };
  },
};

const seen = { imageFetches: 0, imajevCalls: [] as string[] };

const stub = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('https://images.internal/')) {
    seen.imageFetches++;
    return url.endsWith('/gone') ? new Response(null, { status: 404 }) : new Response(IMAGE.bytes);
  }
  const form = init?.body as FormData;
  const request = JSON.parse(form.get('request') as string);
  const [qid] = Object.keys(request.questions);
  seen.imajevCalls.push(qid);
  const hasImage = form.getAll('image').length > 0;
  const choice =
    qid === 'colour' ? (hasImage ? 'red' : 'blue') : qid === 'paid' ? 'paid' : request.state.hint;
  const keys = Object.keys(request.questions[qid].criteria);
  const probabilities = Object.fromEntries(
    keys.map((k) => [k, k === choice ? 0.9 : 0.1 / (keys.length - 1)])
  );
  return new Response(
    JSON.stringify({
      model: 'imajev-4b',
      answers: { [qid]: { type: 'choice', choice, probabilities, confidence: 0.9 } },
    })
  );
});

let dataDir: string;
const arm = (url = 'http://127.0.0.1:8765') => [
  '--model',
  'imajev',
  '--imajev-url',
  url,
  '--imajev-model-name',
  'imajev-4b',
  '--adapter-sha256',
  'abc',
  '--rotations',
  '4',
  '--hardware',
  'test',
];
const nodeArgs = () => [
  '--node',
  node.id,
  '--data-dir',
  dataDir,
  '--format',
  'A',
  '--split',
  'dev',
];

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'decision-eval-mod-'));
  registerNode(node);
  vi.stubGlobal('fetch', stub);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterAll(() => {
  delete (NODES as Record<string, unknown>)[node.id];
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('decision-eval CLI, moderation images', () => {
  it.each([
    ['exclude()', { exclude: undefined }],
    ['excludedIds()', { excludedIds: undefined }],
  ])('🔴 refuses to build a moderation node missing %s', async (_, missing) => {
    const bare = { ...node, ...missing, id: 'test.moderation.bare' };
    registerNode(bare);
    try {
      await expect(main(['build', '--node', bare.id, '--data-dir', dataDir])).rejects.toThrow(
        'must define exclude() and excludedIds()'
      );
    } finally {
      delete (NODES as Record<string, unknown>)[bare.id];
    }
  });

  it('🔴 refuses to run or build training data for a moderation node without excludedIds()', async () => {
    const bare = { ...node, excludedIds: undefined, id: 'test.moderation.noids' };
    registerNode(bare);
    try {
      await expect(
        main([
          'run',
          '--node',
          bare.id,
          '--data-dir',
          dataDir,
          '--format',
          'A',
          '--split',
          'dev',
          ...arm(),
        ])
      ).rejects.toThrow('must define excludedIds()');
      await expect(
        main(['train-manifest', '--node', bare.id, '--data-dir', dataDir, '--candidates', 'unused'])
      ).rejects.toThrow('must define excludedIds()');
    } finally {
      delete (NODES as Record<string, unknown>)[bare.id];
    }
  });

  it('🔴 keeps an excluded item out of the manifest', async () => {
    await main(['build', '--node', node.id, '--data-dir', dataDir]);
    const ids = readFileSync(join(dataDir, node.id, 'manifest.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).itemId);
    expect(ids).toHaveLength(29);
    expect(ids).not.toContain('m4');
  });

  it('the standalone control accepts a private-range text arm, since its image is synthetic', async () => {
    seen.imajevCalls.length = 0;
    await main(['control', ...arm('http://10.0.0.5:8765')]);
    expect(seen.imajevCalls).toEqual(['paid', 'colour']);
  });

  it('🔴 refuses a bare private-range host before sending anything', async () => {
    seen.imajevCalls.length = 0;
    await expect(main(['run', ...nodeArgs(), ...arm('http://10.0.0.5:8765')])).rejects.toThrow(
      'not a bare private range'
    );
    expect(seen.imajevCalls).toEqual([]);
  });

  it('🔴 runs the IMAGE control first, then every item with its image, recording the deleted one as missing', async () => {
    seen.imajevCalls.length = 0;
    seen.imageFetches = 0;
    // Reported after the build sampled it; the run must re-read exclusions before sending.
    reportedLater.add('m7');
    await main(['run', ...nodeArgs(), ...arm()]);
    expect(seen.imajevCalls[0]).toBe('colour');
    expect(seen.imajevCalls.filter((q) => q === 'verdict')).toHaveLength(27);
    expect(seen.imageFetches).toBe(28);

    const runs = join(dataDir, node.id, 'runs');
    const lines = readFileSync(join(runs, readdirSync(runs)[0], 'predictions.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines.map((p) => p.itemId)).not.toContain('m7');
    expect(lines.find((p) => p.itemId === 'm5')?.hardware).toBe('test');
    expect(lines.find((p) => p.itemId === 'm3')).toEqual({
      itemId: 'm3',
      runKey: expect.any(String),
      status: 'missing',
    });
  });

  it('🔴 refuses a training row for an item excluded at build that no eval split ever held', async () => {
    const candidates = join(dataDir, 'mod-candidates.jsonl');
    writeFileSync(
      candidates,
      `${JSON.stringify({
        itemId: 'm4',
        groupKey: 'g-fresh',
        ts: '2026-09-01T00:00:00Z',
        state: {},
        partition: 'train',
      })}\n`
    );
    await expect(
      main(['train-manifest', '--node', node.id, '--data-dir', dataDir, '--candidates', candidates])
    ).rejects.toThrow('are excluded items');
  });

  it('🔴 train-manifest re-reads exclusions, so a report since the last build still keeps an item out', async () => {
    reportedLater.add('never-sampled');
    const candidates = join(dataDir, 'late-candidates.jsonl');
    writeFileSync(
      candidates,
      `${JSON.stringify({
        itemId: 'never-sampled',
        groupKey: 'g-late',
        ts: '2026-09-01T00:00:00Z',
        state: {},
        partition: 'train',
      })}
`
    );
    await expect(
      main(['train-manifest', '--node', node.id, '--data-dir', dataDir, '--candidates', candidates])
    ).rejects.toThrow('are excluded items');
  });

  it('🔴 refuses an excludedIds() that yields a non-string id, which would never match', async () => {
    const numeric = {
      ...node,
      id: 'test.moderation.numeric',
      async *excludedIds() {
        yield 7 as unknown as string;
      },
    };
    registerNode(numeric);
    try {
      await expect(
        main([
          'run',
          '--node',
          numeric.id,
          '--data-dir',
          dataDir,
          '--format',
          'A',
          '--split',
          'dev',
          ...arm(),
        ])
      ).rejects.toThrow('yielded a number');
    } finally {
      delete (NODES as Record<string, unknown>)[numeric.id];
    }
  });
});
