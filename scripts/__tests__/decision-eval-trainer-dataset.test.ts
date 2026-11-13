import { createHash } from 'crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import JSZip from 'jszip';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GoldPolicy, TrainCandidate } from '../decision-eval/builder';
import { main } from '../decision-eval/cli';
import { toImajevQuestions } from '../decision-eval/imajev-client';
import { NODES, registerNode, type NodeSpec } from '../decision-eval/nodes';
import { choiceMapper, choiceTargets, specHash } from '../decision-eval/runner';
import {
  buildTrainerRows,
  IMAJEV_BASE_ADAPTER,
  IMAJEV_BASE_MODEL,
  IMAJEV_TO_REQUEST_COMMIT,
  toImajevRequest,
  TRAINER_MANIFEST_PATH,
  TrainerDatasetError,
  TRAINING_DATA_PLACEHOLDER,
  type TrainerDatasetInput,
  type TrainerRow,
} from '../decision-eval/trainer-dataset';
import type { DecisionQuestion, FormatSpec, GoldRow } from '../decision-eval/types';

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
let excluded = new Set<string>();
let extraGold: GoldRow[] = [];
let goldPolicy: GoldPolicy | undefined;

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
    yield* extraGold;
  },
  goldPolicy: () => goldPolicy ?? { kind: 'majority' },
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
const args = (dir = dataDir) => ['--node', node.id, '--format', 'A', '--data-dir', dir];
const trainManifest = () => join(root(), 'train-manifest.jsonl');
const build = () => main(['build', '--node', node.id, '--data-dir', dataDir]);

function readDataset() {
  const files = readdirSync(datasetDir()).sort();
  expect(files).toHaveLength(2);
  const [sidecarFile, zipFile] = files;
  return {
    files,
    zipFile,
    sidecar: JSON.parse(readFileSync(join(datasetDir(), sidecarFile), 'utf8')),
    zipBytes: readFileSync(join(datasetDir(), zipFile)),
  };
}

async function readZipRows(bytes: Buffer): Promise<TrainerRow[]> {
  const zip = await JSZip.loadAsync(bytes);
  expect(Object.keys(zip.files)).toEqual(['data/', 'data/manifests/', TRAINER_MANIFEST_PATH]);
  const text = await zip.file(TRAINER_MANIFEST_PATH)!.async('string');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

beforeAll(() => {
  registerNode(node);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterAll(() => {
  delete (NODES as Record<string, unknown>)[node.id];
  vi.restoreAllMocks();
});

describe('train-dataset', () => {
  beforeEach(async () => {
    rows = [...SOURCE];
    excluded = new Set();
    extraGold = [];
    goldPolicy = undefined;
    dataDir = mkdtempSync(join(tmpdir(), 'decision-eval-trainer-'));
    await build();
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

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes the zip the trainer reads, and a workflow it does not submit', async () => {
    await main(['train-dataset', ...args()]);
    const { zipFile, sidecar, zipBytes } = readDataset();

    expect(sidecar).toMatchObject({
      schema: 'civitai.decision-eval.trainer-dataset',
      version: 1,
      nodeId: node.id,
      formatId: 'A',
      imajevToRequestCommit: IMAJEV_TO_REQUEST_COMMIT,
      zip: {
        file: zipFile,
        sha256: createHash('sha256').update(zipBytes).digest('hex'),
        bytes: zipBytes.length,
      },
      summary: {
        rows: 10,
        partitions: { train: 8, dev: 2 },
        skipped: { noGold: 1, untrainable: 1, pii: 1 },
      },
    });
    expect(sidecar.specHash).toBe(specHash(node.id, node.specVersion, 'A', [TOPIC]));
    expect(sidecar.evalIndex).toEqual({ itemIds: 5, groupKeys: 5 });
    expect(sidecar.excludedIds).toBe(0);
    expect(zipFile).toBe(`A-${sidecar.specHash}-${sidecar.zip.sha256.slice(0, 12)}.zip`);
    expect(sidecar.workflow.steps[0].input).toEqual({
      engine: 'imajev',
      model: IMAJEV_BASE_MODEL,
      adapter: IMAJEV_BASE_ADAPTER,
      trainingData: { type: 'zip', sourceUrl: TRAINING_DATA_PLACEHOLDER, count: 10 },
      epochs: 1,
    });

    const written = await readZipRows(zipBytes);
    expect(written.map((r) => [r.id, r.partition])).toEqual([
      ...Array.from({ length: 8 }, (_, i) => [`tr${i}`, 'train']),
      ['tr8', 'dev'],
      ['tr9', 'dev'],
    ]);
    expect(written[1]).toEqual({
      id: 'tr1',
      group_key: 'g-tr1',
      partition: 'train',
      request: {
        schema_version: '1.0',
        request_id: 'tr1',
        state: { text: 'ticket 1' },
        fields: [
          {
            id: 'topic',
            question: 'Which topic?',
            type: 'choice',
            options: [
              { value: 'x', description: 'topic x' },
              { value: 'y', description: 'topic y' },
            ],
          },
        ],
        execution: { mode: 'inspect', allow_external_fallback: false },
      },
      jev: {
        state: { text: 'ticket 1' },
        questions: {
          topic: {
            type: 'choice',
            instructions: 'Which topic?',
            criteria: { x: 'topic x', y: 'topic y' },
          },
        },
      },
      targets: { topic: 'x' },
      images: [],
    });
  });

  it('writes the same zip whatever the clock says', async () => {
    await main(['train-dataset', ...args()]);
    const first = readDataset().files;
    // A zip entry records its mtime to 2 s, so only a different day can expose a clock-dependent zip.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 86_400_000 });
    await main(['train-dataset', ...args()]);
    expect(readDataset().files).toEqual(first);
  });

  it('passes --epochs to the workflow and refuses one out of range', async () => {
    await main(['train-dataset', ...args(), '--epochs', '3']);
    expect(readDataset().sidecar.workflow.steps[0].input.epochs).toBe(3);
    for (const edge of ['0.1', '10']) {
      await expect(main(['train-dataset', ...args(), '--epochs', edge])).resolves.toBeUndefined();
    }
    for (const bad of ['abc', '11', '0', '0.09']) {
      await expect(main(['train-dataset', ...args(), '--epochs', bad])).rejects.toThrow(
        `--epochs must be 0.1-10, got ${bad}`
      );
    }
  });

  it('refuses a train manifest holding a planted eval test id', async () => {
    // A group key the index has never held, so only the item id can give it away.
    const planted = candidate(PLANTED_TEST_ID, 'train', 'g-never-eval');
    writeFileSync(
      trainManifest(),
      `${readFileSync(trainManifest(), 'utf8')}${JSON.stringify(planted)}\n`
    );
    await expect(main(['train-dataset', ...args()])).rejects.toThrow(
      `1 training row(s) collide with the eval index (first: item ${PLANTED_TEST_ID}, partition train); refusing to build`
    );
  });

  it('refuses a group that entered the eval index after train-manifest ran', async () => {
    rows = [
      ...SOURCE,
      { itemId: 'late', raw: { text: 'late', gold: 'x', split: 'test', group: 'g-late' } },
    ];
    await build();
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

  it('resolves gold with the node policy, as scoring does', async () => {
    extraGold = [{ itemId: 'tr0', gold: 'x', goldSource: 'test' }];
    goldPolicy = { kind: 'disagreement-as', label: 'z' };
    await build();
    await main(['train-dataset', ...args()]);
    const { sidecar, zipBytes } = readDataset();
    expect(sidecar.summary.skipped).toEqual({ noGold: 1, untrainable: 2, pii: 1 });
    expect((await readZipRows(zipBytes)).map((r) => r.id)).not.toContain('tr0');

    goldPolicy = { kind: 'disagreement-as', label: 'nope' };
    await expect(main(['train-dataset', ...args()])).rejects.toThrow(
      'gold policy label "nope" is not a class of test.trainer'
    );
  });

  it('refuses to run before build or train-manifest', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'decision-eval-trainer-empty-'));
    try {
      await expect(main(['train-dataset', ...args(empty)])).rejects.toThrow('no eval index at');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    writeFileSync(trainManifest(), '');
    await expect(main(['train-dataset', ...args()])).rejects.toThrow('run train-manifest first');
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
  const withCandidate = (c: unknown) =>
    input({ candidates: [c as TrainCandidate, candidate('tr1', 'trainer-dev')] });

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
    expect(() => buildTrainerRows(withCandidate(withImage))).toThrow(
      'item tr0 carries images; image datasets are not supported'
    );
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
    ['a negative level', { topic: 'x', urgent: true, effort: -1 }, 'effort to -1'],
    ['a fractional level', { topic: 'x', urgent: true, effort: 0.5 }, 'effort to 0.5'],
  ])('refuses %s', (_, targets, message) => {
    expect(() => buildTrainerRows(input({ format: format(() => targets) }))).toThrow(message);
  });

  it.each([
    ['a missing question', { topic: 'x', urgent: true }, '[topic, urgent]'],
    [
      'an extra key',
      { topic: 'x', urgent: true, effort: 0, extra: 1 },
      '[effort, extra, topic, urgent]',
    ],
  ])('refuses targets with %s', (_, targets, got) => {
    expect(() => buildTrainerRows(input({ format: format(() => targets) }))).toThrow(
      `gives targets for ${got}, the format asks [effort, topic, urgent]`
    );
  });

  it.each([
    ['a numeric group key', { groupKey: 7 }, 'training row 1: groupKey must be'],
    ['an empty group key', { groupKey: '' }, 'training row 1: groupKey must be'],
    ['a numeric item id', { itemId: 7 }, 'training row 1: itemId must be'],
    ['an empty item id', { itemId: '' }, 'training row 1: itemId must be'],
    ['an unknown partition', { partition: 'dev' }, 'training row 1: partition must be'],
    ['a non-string state', { state: { n: 1 } }, 'training row 1: state must be'],
    ['a null state', { state: null }, 'training row 1: state must be'],
    ['an array state', { state: ['a'] }, 'training row 1: state must be'],
  ])('refuses a train manifest row with %s', (_, over, message) => {
    expect(() =>
      buildTrainerRows(withCandidate({ ...candidate('tr0', 'train'), ...over }))
    ).toThrow(message);
  });

  it.each([
    ['train first', candidate('tr0', 'train'), candidate('tr1', 'trainer-dev', 'g-tr0')],
    ['trainer-dev first', candidate('tr0', 'trainer-dev'), candidate('tr1', 'train', 'g-tr0')],
  ])('refuses a group in both trainer partitions, %s', (_, first, second) => {
    expect(() => buildTrainerRows(input({ candidates: [first, second] }))).toThrow(
      'training row 2: its group is in both trainer partitions'
    );
  });

  it.each([
    ['group key', { groupKey: 'requester:someone@example.com' }, 'group_key'],
    ['item id', { itemId: 'someone@example.com' }, 'id'],
  ])(
    'refuses a %s that looks like personal data, before the leakage check names it',
    (_, over, field) => {
      // Unlabelled AND in the eval index: the refusal must come first and must not echo the value.
      const row = { ...candidate('tr0', 'train'), ...over };
      const run = () =>
        buildTrainerRows({
          ...withCandidate(row),
          gold: new Map([['tr1', 'y']]),
          index: { itemIds: [row.itemId], groupKeys: [row.groupKey] },
        });
      expect(run).toThrow(
        `training row 1: its ${field} is email-shaped; a node's ids must not carry personal data`
      );
      expect(run).not.toThrow(/someone@example\.com/);
    }
  );

  it('refuses a dataset with an empty partition', () => {
    expect(() =>
      buildTrainerRows(
        input({ candidates: [candidate('tr0', 'train'), candidate('tr1', 'train')] })
      )
    ).toThrow('got train 2, dev 0');
  });

  it('refuses duplicate question ids, which the serving payload cannot carry', () => {
    expect(() => toImajevRequest('r', {}, [TOPIC, TOPIC])).toThrow(TrainerDatasetError);
  });

  it('choiceTargets trains each class as the option of the same name', () => {
    expect(choiceTargets('topic')('billing_buzz')).toEqual({ topic: 'billing_buzz' });
    expect(choiceTargets('topic')('cannot_tell')).toEqual({ topic: 'cannot_tell' });
  });

  it('choiceTargets trains unknownClasses as imajev unknown, not as their option', () => {
    const targets = choiceTargets('topic', { unknownClasses: ['y'] });
    const { rows } = buildTrainerRows(
      input({
        questions: [TOPIC],
        format: { questions: [TOPIC], mapAnswer: choiceMapper('topic'), trainTargets: targets },
      })
    );
    expect(rows.map((r) => [r.id, r.targets])).toEqual([
      ['tr0', { topic: 'x' }],
      ['tr1', { topic: null }],
    ]);
  });
});

describe('toImajevRequest against imajev jev_api.to_request', () => {
  const fixtures = join(__dirname, 'fixtures', 'imajev-to-request');
  // Mirrors expand() in generate.py.
  const expand = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length === 2 && '$repeat' in o && 'times' in o) {
        return (o.$repeat as string).repeat(o.times as number);
      }
      return Object.fromEntries(keys.map((k) => [k, expand(o[k])]));
    }
    return value;
  };
  const cases = (JSON.parse(readFileSync(join(fixtures, 'cases.json'), 'utf8')) as unknown[]).map(
    expand
  ) as Array<{ name: string; state: Record<string, string>; questions: DecisionQuestion[] }>;
  const golden = JSON.parse(readFileSync(join(fixtures, 'golden.json'), 'utf8')) as {
    imajevCommit: string;
    cases: Array<{
      name: string;
      requestId: string;
      jev: unknown;
      request: unknown;
      requestSha256?: string;
    }>;
  };

  it('was generated at the pinned imajev commit, from these cases', () => {
    expect(golden.imajevCommit).toBe(IMAJEV_TO_REQUEST_COMMIT);
    expect(golden.cases.map((c) => c.name)).toEqual(cases.map((c) => c.name));
  });

  it('agrees with imajev on which cases are refused', () => {
    const refused = golden.cases.filter((c) => c.request === null && !c.requestSha256);
    expect(refused.map((c) => c.name)).toEqual(
      golden.cases.filter((c) => c.name.startsWith('error:')).map((c) => c.name)
    );
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.length).toBeLessThan(golden.cases.length);
  });

  it.each(cases.map((c, i) => [c.name, c, golden.cases[i]] as const))('%s', (_, c, g) => {
    // Stringified so key order counts: criteria's key order is the option order serving sends.
    // (JSON.parse re-sorts integer-like keys, so those cases lean on the request comparison.)
    expect(JSON.stringify(toImajevQuestions(c.questions))).toBe(JSON.stringify(g.jev));
    const build = () => toImajevRequest(g.requestId, c.state, c.questions);
    if (g.requestSha256) {
      expect(createHash('sha256').update(JSON.stringify(build())).digest('hex')).toBe(
        g.requestSha256
      );
    } else if (g.request === null) {
      expect(build).toThrow(TrainerDatasetError);
    } else {
      expect(JSON.stringify(build())).toBe(JSON.stringify(g.request));
    }
  });
});
