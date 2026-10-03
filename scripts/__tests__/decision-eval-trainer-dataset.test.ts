import { createHash } from 'crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import JSZip from 'jszip';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { TrainCandidate } from '../decision-eval/builder';
import { main } from '../decision-eval/cli';
import { toImajevQuestions } from '../decision-eval/imajev-client';
import { NODES, registerNode, type NodeSpec } from '../decision-eval/nodes';
import { choiceMapper, choiceTargets } from '../decision-eval/runner';
import {
  buildTrainerRows,
  IMAJEV_TO_REQUEST_COMMIT,
  toImajevRequest,
  TRAINER_MANIFEST_PATH,
  TrainerDatasetError,
  TRAINING_DATA_PLACEHOLDER,
  type TrainerDatasetInput,
  type TrainerRow,
} from '../decision-eval/trainer-dataset';
import type { DecisionQuestion, FormatSpec } from '../decision-eval/types';

type Raw = {
  text: string;
  gold: 'x' | 'y' | 'z' | null;
  split: 'train' | 'dev' | 'test';
  group?: string;
};

const PLANTED_TEST_ID = 'a1-test-7';

const SOURCE: Array<{ itemId: string; raw: Raw }> = [
  ...Array.from({ length: 12 }, (_, i) => ({
    itemId: `tr${i}`,
    raw: {
      text: i === 10 ? 'mail me at someone@example.com' : `ticket ${i}`,
      gold: (i === 11 ? 'z' : i % 2 ? 'x' : 'y') as Raw['gold'],
      split: 'train' as const,
    },
  })),
  ...Array.from({ length: 4 }, (_, i) => ({
    itemId: `d${i}`,
    raw: { text: `dev ${i}`, gold: 'x' as const, split: 'dev' as const },
  })),
  { itemId: PLANTED_TEST_ID, raw: { text: 'sealed', gold: 'y', split: 'test' } },
];
let rows = [...SOURCE];
const excluded = new Set<string>();

const TOPIC: DecisionQuestion = {
  id: 'topic',
  type: 'choice',
  instructions: 'Which topic?',
  options: [
    { key: 'x', description: 'topic x' },
    { key: 'y', description: 'topic y' },
  ],
};

const node: NodeSpec<Raw> = {
  id: 'test.trainer',
  specVersion: 1,
  dataClass: 'public-text',
  classes: ['x', 'y', 'z'],
  formats: {
    A: {
      questions: [TOPIC],
      mapAnswer: choiceMapper('topic'),
      trainTargets: (gold) => (gold === 'z' ? null : { topic: gold }),
    },
  },
  buildState: (raw) => ({ text: raw.text }),
  async *excludedIds() {
    yield* excluded;
  },
  async *source() {
    for (const r of rows) {
      yield {
        itemId: r.itemId,
        groupKey: r.raw.group ?? `g-${r.itemId}`,
        ts: '2026-09-01T00:00:00Z',
        raw: r.raw,
        split: r.raw.split,
      };
    }
  },
  async *gold() {
    for (const r of rows) {
      if (r.raw.gold) yield { itemId: r.itemId, gold: r.raw.gold, goldSource: 'test' };
    }
  },
};

const candidate = (
  itemId: string,
  partition: TrainCandidate['partition'],
  groupKey = `g-${itemId}`
) =>
  ({
    itemId,
    groupKey,
    ts: '2026-09-01T00:00:00Z',
    state: { text: SOURCE.find((s) => s.itemId === itemId)?.raw.text ?? 'no label yet' },
    partition,
  } satisfies TrainCandidate);

const CANDIDATES: TrainCandidate[] = [
  ...Array.from({ length: 8 }, (_, i) => candidate(`tr${i}`, 'train')),
  ...[8, 9, 10, 11].map((i) => candidate(`tr${i}`, 'trainer-dev')),
  candidate('unlabelled', 'train', 'g-late'),
];

let dataDir: string;
const root = () => join(dataDir, node.id);
const datasetDir = () => join(root(), 'trainer-datasets');
const args = () => ['--node', node.id, '--format', 'A', '--data-dir', dataDir];
const trainManifest = () => join(root(), 'train-manifest.jsonl');

async function readZipRows(file: string): Promise<TrainerRow[]> {
  const zip = await JSZip.loadAsync(readFileSync(file));
  expect(Object.keys(zip.files)).toEqual(['data/', 'data/manifests/', TRAINER_MANIFEST_PATH]);
  const text = await zip.file(TRAINER_MANIFEST_PATH)!.async('string');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'decision-eval-trainer-'));
  registerNode(node);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await main(['build', '--node', node.id, '--data-dir', dataDir]);
  const candidatesFile = join(dataDir, 'candidates.jsonl');
  writeFileSync(candidatesFile, CANDIDATES.map((c) => JSON.stringify(c)).join('\n'));
  await main([
    'train-manifest',
    '--node',
    node.id,
    '--candidates',
    candidatesFile,
    '--data-dir',
    dataDir,
  ]);
});

afterAll(() => {
  delete (NODES as Record<string, unknown>)[node.id];
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('train-dataset', () => {
  it('writes the zip the trainer reads, and a workflow it does not submit', async () => {
    await main(['train-dataset', ...args()]);
    const files = readdirSync(datasetDir()).sort();
    expect(files).toHaveLength(2);
    const [sidecarFile, zipFile] = files;
    const sidecar = JSON.parse(readFileSync(join(datasetDir(), sidecarFile), 'utf8'));
    const zipBytes = readFileSync(join(datasetDir(), zipFile));

    expect(sidecar.zip).toEqual({
      file: zipFile,
      sha256: createHash('sha256').update(zipBytes).digest('hex'),
      bytes: zipBytes.length,
    });
    expect(sidecar.summary).toEqual({
      rows: 10,
      partitions: { train: 8, dev: 2 },
      skipped: { noGold: 1, untrainable: 1, pii: 1 },
    });
    expect(sidecar.workflow.steps[0].input.trainingData).toEqual({
      type: 'zip',
      sourceUrl: TRAINING_DATA_PLACEHOLDER,
      count: 10,
    });

    const written = await readZipRows(join(datasetDir(), zipFile));
    expect(written.map((r) => [r.id, r.partition])).toEqual([
      ...Array.from({ length: 8 }, (_, i) => [`tr${i}`, 'train']),
      ['tr8', 'dev'],
      ['tr9', 'dev'],
    ]);
    expect(written[1]).toEqual({
      id: 'tr1',
      group_key: 'g-tr1',
      partition: 'train',
      request: toImajevRequest('tr1', { text: 'ticket 1' }, [TOPIC]),
      jev: { state: { text: 'ticket 1' }, questions: toImajevQuestions([TOPIC]) },
      targets: { topic: 'x' },
      images: [],
    });

    await main(['train-dataset', ...args()]);
    expect(readdirSync(datasetDir()).sort()).toEqual(files);
  });

  it('refuses a train manifest holding a planted eval test id', async () => {
    const before = readFileSync(trainManifest(), 'utf8');
    // A group key the index has never held, so only the item id can give it away.
    const planted = candidate(PLANTED_TEST_ID, 'train', 'g-never-eval');
    writeFileSync(trainManifest(), `${before}${JSON.stringify(planted)}\n`);
    try {
      await expect(main(['train-dataset', ...args()])).rejects.toThrow(
        `1 training row(s) collide with the eval index (first: item ${PLANTED_TEST_ID}, partition train); refusing to build`
      );
    } finally {
      writeFileSync(trainManifest(), before);
    }
  });

  it('refuses a group that entered the eval index after train-manifest ran', async () => {
    rows = [
      ...SOURCE,
      { itemId: 'late', raw: { text: 'late', gold: 'x', split: 'test', group: 'g-late' } },
    ];
    await main(['build', '--node', node.id, '--data-dir', dataDir]);
    await expect(main(['train-dataset', ...args()])).rejects.toThrow(
      '1 training row(s) collide with the eval index (first: item unlabelled, partition train)'
    );
  });

  it('refuses an item excluded after train-manifest ran', async () => {
    excluded.add('tr2');
    await expect(main(['train-dataset', ...args()])).rejects.toThrow(
      '1 training row(s) are excluded items (first: item tr2); refusing to build'
    );
  });
});

describe('buildTrainerRows', () => {
  const NOUL: DecisionQuestion = { id: 'urgent', type: 'noul', instructions: 'Is it urgent?' };
  const SCORE: DecisionQuestion = {
    id: 'effort',
    type: 'score',
    instructions: 'How much effort?',
    criteria: ['none', 'some', 'lots'],
  };
  const format = (trainTargets: FormatSpec['trainTargets']): FormatSpec => ({
    questions: [TOPIC, NOUL, SCORE],
    mapAnswer: choiceMapper('topic'),
    trainTargets,
  });
  const input = (over: Partial<TrainerDatasetInput> = {}): TrainerDatasetInput => ({
    nodeId: 'n',
    dataClass: 'support-text',
    candidates: [candidate('tr0', 'train'), candidate('tr1', 'trainer-dev')],
    index: { itemIds: [], groupKeys: [] },
    excludedIds: [],
    gold: new Map([
      ['tr0', 'x'],
      ['tr1', 'y'],
    ]),
    questions: [TOPIC, NOUL, SCORE],
    format: format((gold) => ({ topic: gold, urgent: gold === 'x', effort: 2 })),
    ...over,
  });

  it('carries choice, noul, score and unknown targets through', () => {
    const { rows } = buildTrainerRows(
      input({ format: format((gold) => ({ topic: gold, urgent: null, effort: 0 })) })
    );
    expect(rows.map((r) => r.targets)).toEqual([
      { topic: 'x', urgent: null, effort: 0 },
      { topic: 'y', urgent: null, effort: 0 },
    ]);
    expect(buildTrainerRows(input()).rows[0].targets).toEqual({
      topic: 'x',
      urgent: true,
      effort: 2,
    });
  });

  it('refuses moderation data', () => {
    expect(() => buildTrainerRows(input({ dataClass: 'moderation-image' }))).toThrow(
      'n is moderation data; training datasets are not built from it yet'
    );
  });

  it('refuses a row with images', () => {
    const withImage = { ...candidate('tr0', 'train'), imageRefs: [{ url: 'https://x/1.jpg' }] };
    expect(() =>
      buildTrainerRows(input({ candidates: [withImage, candidate('tr1', 'trainer-dev')] }))
    ).toThrow('item tr0 carries images; image datasets are not supported');
  });

  it('refuses a format without trainTargets', () => {
    expect(() => buildTrainerRows(input({ format: format(undefined) }))).toThrow(
      'this format of n defines no trainTargets'
    );
  });

  it.each([
    [
      'an option the question does not have',
      { topic: 'q', urgent: true, effort: 0 },
      'topic to "q"',
    ],
    ['a string for a noul', { topic: 'x', urgent: 'yes', effort: 0 }, 'urgent to "yes"'],
    ['a level past the rubric', { topic: 'x', urgent: true, effort: 3 }, 'effort to 3'],
    ['a fractional level', { topic: 'x', urgent: true, effort: 0.5 }, 'effort to 0.5'],
  ])('refuses %s', (_, targets, message) => {
    expect(() => buildTrainerRows(input({ format: format(() => targets) }))).toThrow(message);
  });

  it('refuses targets that do not cover every question', () => {
    expect(() =>
      buildTrainerRows(input({ format: format(() => ({ topic: 'x', urgent: true })) }))
    ).toThrow('gives targets for [topic, urgent], the format asks [effort, topic, urgent]');
  });

  it('refuses a dataset with an empty partition', () => {
    expect(() =>
      buildTrainerRows(
        input({ candidates: [candidate('tr0', 'train'), candidate('tr1', 'train')] })
      )
    ).toThrow('got train 2, dev 0');
  });

  it('choiceTargets trains each class as the option of the same name', () => {
    expect(choiceTargets('topic')('billing_buzz')).toEqual({ topic: 'billing_buzz' });
  });
});

describe('toImajevRequest against imajev jev_api.to_request', () => {
  const golden = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'imajev-to-request', 'golden.json'), 'utf8')
  ) as {
    imajevCommit: string;
    cases: Array<{
      name: string;
      requestId: string;
      state: Record<string, string>;
      questions: DecisionQuestion[];
      jev: unknown;
      request: unknown;
    }>;
  };

  it('was generated at the pinned imajev commit', () => {
    expect(golden.imajevCommit).toBe(IMAJEV_TO_REQUEST_COMMIT);
    expect(golden.cases.filter((c) => c.request !== null)).toHaveLength(4);
    expect(golden.cases.filter((c) => c.request === null)).toHaveLength(8);
  });

  it.each(golden.cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(toImajevQuestions(c.questions)).toEqual(c.jev);
    if (c.request === null) {
      expect(() => toImajevRequest(c.requestId, c.state, c.questions)).toThrow(TrainerDatasetError);
    } else {
      expect(toImajevRequest(c.requestId, c.state, c.questions)).toEqual(c.request);
    }
  });
});
