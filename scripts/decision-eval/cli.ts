import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { parseArgs } from 'util';

import {
  applyExclusions,
  buildEvalIndex,
  buildTrainManifest,
  enforceGroupIsolation,
  EVAL_INDEX_FILE,
  EXCLUSIONS_FILE,
  mergeManifest,
  parseEvalIndex,
  parseExclusions,
  resolveGold,
  serializeEvalIndex,
  serializeExclusions,
  timeSplit,
  type TrainCandidate,
} from './builder';
import {
  IMAGE_CONTROL,
  TEXT_CONTROL,
  majorityBaseline,
  plantFlippedLabels,
  randomBaseline,
  runKnownAnswerControl,
  verifyPlantedFlips,
} from './controls';
import { ImajevModel } from './imajev-client';
import { JevArm } from './jev-arm';
import { cohensKappa } from './metrics';
import { getNode, parseQuestionsFile, type NodeSpec } from './nodes';
import { percentile, renderReport } from './report';
import { doneItemIds, HttpImageSource, runItems, runKey, specHash } from './runner';
import { assertDataDirOutsideRepo } from './safety';
import { countCorrect, fitThresholds, scoreSplit } from './scorer';
import { readJson, readJsonl, writeFileAtomic, writeJsonl } from './store';
import type {
  DecisionQuestion,
  GoldRow,
  ImageDecisionModel,
  ManifestItem,
  Prediction,
  TextDecisionModel,
} from './types';

/**
 * Offline eval harness for decision models (foundation #eval).
 *
 *   pnpm run tsscript scripts/decision-eval/cli.ts control --model imajev --imajev-url http://127.0.0.1:8765 ...
 *   pnpm run tsscript scripts/decision-eval/cli.ts build   --node <id> --data-dir <dir> [--drop-overlap]
 *   pnpm run tsscript scripts/decision-eval/cli.ts run     --node <id> --format <f> --model <arm> --split dev --data-dir <dir>
 *   pnpm run tsscript scripts/decision-eval/cli.ts score   --node <id> --format <f> --model <arm> --split dev --target 0.95 --data-dir <dir>
 *   pnpm run tsscript scripts/decision-eval/cli.ts train-manifest --node <id> --candidates <jsonl> --data-dir <dir>
 *
 * Every data file lives under --data-dir, which must be outside any git checkout.
 * `run` is incremental: re-running it only sends items not yet predicted under
 * the same model config and question spec, which is what a daily moderation
 * pass needs before removed images are deleted.
 */

const FLIP_SEED = 20261003;
const FLIP_COUNT = 20;

type SealedEntry = {
  runKey: string;
  formatId: string;
  specHash: string;
  modelConfigId: string;
  at: string;
  reason: string | null;
};

function paths(dataDir: string, nodeId: string) {
  const root = join(dataDir, nodeId);
  return {
    root,
    manifest: join(root, 'manifest.jsonl'),
    gold: join(root, 'gold.jsonl'),
    evalIndex: join(root, EVAL_INDEX_FILE),
    exclusions: join(root, EXCLUSIONS_FILE),
    controls: join(root, 'controls.jsonl'),
    sealed: join(root, 'sealed-test.json'),
    predictions: (key: string) => join(root, 'runs', key, 'predictions.jsonl'),
    report: (key: string, split: string) => join(root, 'runs', key, `report-${split}.md`),
    thresholds: (key: string, split: string) => join(root, 'runs', key, `thresholds-${split}.json`),
  };
}

function loadQuestions(
  node: NodeSpec<never>,
  formatId: string,
  dataDir: string
): DecisionQuestion[] {
  const format = node.formats[formatId];
  if (!format) throw new Error(`node ${node.id} has no format "${formatId}"`);
  if (Array.isArray(format.questions)) return [...format.questions];
  const file = join(dataDir, node.id, (format.questions as { fromDataDir: string }).fromDataDir);
  return parseQuestionsFile(JSON.parse(readFileSync(file, 'utf8')), file);
}

function loadExclusions(path: string, nodeId: string): string[] {
  const json = readJson<unknown>(path);
  return json === undefined ? [] : parseExclusions(json, nodeId);
}

type Args = Record<string, string | boolean | string[] | undefined>;

function str(args: Args, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || !v) throw new Error(`--${name} is required`);
  return v;
}

function buildModel(args: Args): TextDecisionModel | ImageDecisionModel {
  const arm = str(args, 'model');
  if (arm === 'jev') return new JevArm();
  if (arm === 'imajev') {
    return new ImajevModel({
      baseUrl: (args['imajev-url'] as string) || process.env.IMAJEV_EVAL_URL || '',
      allowedHosts: (args['allow-host'] as string[]) ?? [],
      launch: {
        modelName: str(args, 'imajev-model-name'),
        adapterSha256: str(args, 'adapter-sha256'),
        rotations: Number(str(args, 'rotations')),
        calibrationSha256: (args['calibration-sha256'] as string) || null,
        hardware: str(args, 'hardware'),
      },
    });
  }
  throw new Error(`unknown --model ${arm}; expected imajev or jev`);
}

async function cmdControl(args: Args) {
  const model = buildModel(args);
  const text = await runKnownAnswerControl(model, TEXT_CONTROL, 'public-text');
  console.log(`text control passed on ${text.build}`);
  if (model.hosting === 'self-hosted') {
    const image = await runKnownAnswerControl(model, IMAGE_CONTROL, 'moderation-image');
    console.log(`image control passed on ${image.build}`);
  }
}

async function cmdBuild(args: Args, dataDir: string) {
  const node = getNode(str(args, 'node'));
  if (node.dataClass === 'moderation-image' && !node.exclude) {
    throw new Error(`${node.id} handles moderation images and must define exclude()`);
  }
  const ctx = { dataDir };
  const now = new Date();
  const p = paths(dataDir, node.id);
  const items: ManifestItem[] = [];
  const newlyExcluded: string[] = [];
  const excludedReasons = new Map<string, number>();
  for await (const row of node.source(ctx)) {
    const reason = node.exclude?.(row.raw) ?? null;
    if (reason) {
      newlyExcluded.push(row.itemId);
      excludedReasons.set(reason, (excludedReasons.get(reason) ?? 0) + 1);
      continue;
    }
    items.push({
      itemId: row.itemId,
      groupKey: row.groupKey,
      ts: row.ts,
      split: row.split ?? timeSplit(row.ts, now),
      state: node.buildState(row.raw),
      imageRefs: node.imageRefs?.(row.raw),
      slices: node.slices?.(row.raw),
      baselines: node.baselines?.(row.raw),
    });
  }
  const dropOverlap = args['drop-overlap'] === true;
  const existing = await readJsonl<ManifestItem>(p.manifest);
  const known = new Set(existing.map((i) => i.itemId));
  const isolated = enforceGroupIsolation(
    items.filter((i) => !known.has(i.itemId)),
    { dropLaterOverlap: dropOverlap }
  );
  const merged = mergeManifest(existing, isolated.items, { dropConflicts: dropOverlap });
  const excluded = applyExclusions(
    merged.items,
    loadExclusions(p.exclusions, node.id),
    newlyExcluded
  );

  const goldKeys = new Set<string>();
  const gold: GoldRow[] = [];
  for (const row of await readJsonl<GoldRow>(p.gold)) {
    goldKeys.add(JSON.stringify(row));
    gold.push(row);
  }
  for await (const row of node.gold(ctx)) {
    if (!node.classes.includes(row.gold))
      throw new Error(`gold "${row.gold}" is not a class of ${node.id}`);
    if (goldKeys.has(JSON.stringify(row))) continue;
    goldKeys.add(JSON.stringify(row));
    gold.push(row);
  }
  const previousIndex = readJson<unknown>(p.evalIndex);

  // The index and the exclusions only grow, so writing them first means a crash
  // part-way leaves them a superset of the manifest, never a subset.
  writeFileAtomic(
    p.evalIndex,
    JSON.stringify(
      serializeEvalIndex(
        node.id,
        buildEvalIndex(
          merged.items,
          previousIndex === undefined ? undefined : parseEvalIndex(previousIndex, node.id)
        ),
        now
      )
    )
  );
  writeFileAtomic(p.exclusions, JSON.stringify(serializeExclusions(node.id, excluded.excluded)));
  writeJsonl(p.manifest, excluded.items);
  writeJsonl(p.gold, gold);
  console.log(
    `manifest ${excluded.items.length} items (${merged.added} new); dropped ${
      isolated.dropped.length + merged.dropped.length
    } for group overlap; removed ${excluded.removed} excluded; excluded this build ${JSON.stringify(
      Object.fromEntries(excludedReasons)
    )}`
  );
}

function resolveRun(args: Args, dataDir: string) {
  const node = getNode(str(args, 'node'));
  const formatId = str(args, 'format');
  const questions = loadQuestions(node, formatId, dataDir);
  const model = buildModel(args);
  const spec = specHash(node.id, node.specVersion, formatId, questions);
  return { node, formatId, questions, model, spec, key: runKey(model.configId, spec) };
}

async function cmdRun(args: Args, dataDir: string) {
  const { node, formatId, questions, model, spec, key } = resolveRun(args, dataDir);
  const split = str(args, 'split');
  const p = paths(dataDir, node.id);
  const control =
    node.control ?? (node.dataClass === 'moderation-image' ? IMAGE_CONTROL : TEXT_CONTROL);
  const passed = await runKnownAnswerControl(model, control, node.dataClass);
  mkdirSync(p.root, { recursive: true });
  appendFileSync(
    p.controls,
    `${JSON.stringify({ runKey: key, at: new Date().toISOString(), ...passed })}\n`
  );
  const excluded = new Set(loadExclusions(p.exclusions, node.id));
  const items = (await readJsonl<ManifestItem>(p.manifest)).filter(
    (i) => i.split === split && !excluded.has(i.itemId)
  );
  const predPath = p.predictions(key);
  mkdirSync(dirname(predPath), { recursive: true });
  const summary = await runItems({
    items,
    questions,
    format: node.formats[formatId],
    model,
    dataClass: node.dataClass,
    runKey: key,
    imageSource: new HttpImageSource(),
    done: doneItemIds(await readJsonl<Prediction>(predPath), key),
    onPrediction: (pred) => appendFileSync(predPath, `${JSON.stringify(pred)}\n`),
  });
  console.log(`run ${key} (spec ${spec}): ${JSON.stringify(summary)}`);
}

async function cmdScore(args: Args, dataDir: string) {
  const { node, formatId, model, spec, key } = resolveRun(args, dataDir);
  const split = str(args, 'split');
  if (split !== 'dev' && split !== 'test') throw new Error('--split must be dev or test');
  const fallback = Number(str(args, 'target'));
  const targets = Object.fromEntries(
    node.classes.map((cls) => [cls, node.targets?.[cls] ?? fallback])
  );
  for (const [cls, t] of Object.entries(targets)) {
    if (!(t > 0 && t < 1)) throw new Error(`target for ${cls} must be between 0 and 1, got ${t}`);
  }
  const p = paths(dataDir, node.id);
  const control = (await readJsonl<{ runKey: string; build: string }>(p.controls)).find(
    (c) => c.runKey === key
  );
  if (!control)
    throw new Error(`no passing known-answer control recorded for run ${key}; run it first`);

  const sealed = readJson<SealedEntry[]>(p.sealed) ?? [];
  const priorTestScorings = sealed.filter(
    (e) => e.formatId === formatId && e.specHash === spec
  ).length;
  if (split === 'test') {
    const reason = typeof args['reseal-reason'] === 'string' ? args['reseal-reason'] : null;
    const previous = sealed.find((e) => e.runKey === key);
    if (previous && !reason) {
      throw new Error(
        `the sealed test was already scored for ${key} at ${previous.at}; pass --reseal-reason to score it again`
      );
    }
    // Sealed before anything is written: a crash after scoring still counts as a look.
    writeFileAtomic(
      p.sealed,
      JSON.stringify(
        [
          ...sealed,
          {
            runKey: key,
            formatId,
            specHash: spec,
            modelConfigId: model.configId,
            at: new Date().toISOString(),
            reason,
          },
        ],
        null,
        2
      )
    );
  }

  const excluded = new Set(loadExclusions(p.exclusions, node.id));
  const items = (await readJsonl<ManifestItem>(p.manifest)).filter((i) => !excluded.has(i.itemId));
  const policy = node.goldPolicy?.({ dataDir }) ?? { kind: 'majority' as const };
  if (policy.kind === 'disagreement-as' && !node.classes.includes(policy.label)) {
    throw new Error(`gold policy label "${policy.label}" is not a class of ${node.id}`);
  }
  const resolved = resolveGold(await readJsonl<GoldRow>(p.gold), policy);
  const predictions = (await readJsonl<Prediction>(p.predictions(key))).filter(
    (x) => x.runKey === key
  );
  const base = { items, classes: node.classes };

  const splitIdSet = new Set(items.filter((i) => i.split === split).map((i) => i.itemId));
  const splitGold = new Map([...resolved.gold].filter(([id]) => splitIdSet.has(id)));
  const { planted } = plantFlippedLabels(
    splitGold,
    node.classes,
    Math.min(FLIP_COUNT, splitGold.size),
    FLIP_SEED
  );
  const flips = verifyPlantedFlips(predictions, resolved.gold, planted, (g) =>
    countCorrect({ ...base, predictions }, g)
  );

  const input = { ...base, predictions, gold: resolved.gold };
  const fits = fitThresholds(input, targets);
  const thresholds = Object.fromEntries(
    Object.entries(fits).flatMap(([cls, f]) => (f.status === 'fitted' ? [[cls, f.threshold]] : []))
  );
  // The majority class comes from train, else dev; never from the split being scored when another exists.
  const priorSplit = items.some((i) => i.split === 'train' && resolved.gold.has(i.itemId))
    ? 'train'
    : 'dev';
  const priorIds = new Set(items.filter((i) => i.split === priorSplit).map((i) => i.itemId));
  const priorGold = new Map([...resolved.gold].filter(([id]) => priorIds.has(id)));
  const splitIds = [...splitIdSet];
  const nodeBaselines = Object.fromEntries(
    [...new Set(items.flatMap((i) => Object.keys(i.baselines ?? {})))].map((name) => [
      name,
      scoreSplit(
        {
          ...base,
          gold: resolved.gold,
          predictions: items
            .filter((i) => i.split === split && i.baselines && name in i.baselines)
            .map((i) => ({
              itemId: i.itemId,
              runKey: `baseline:${name}`,
              status: 'ok' as const,
              pred: i.baselines?.[name] ?? null,
              confidence: null,
              abstained: (i.baselines?.[name] ?? null) === null,
            })),
        },
        split
      ),
    ])
  );
  const baselines = {
    ...nodeBaselines,
    [`majority (from ${priorSplit})`]: scoreSplit(
      { ...base, gold: resolved.gold, predictions: majorityBaseline(splitIds, priorGold) },
      split,
      thresholds
    ),
    random: scoreSplit(
      {
        ...base,
        gold: resolved.gold,
        predictions: randomBaseline(splitIds, node.classes, FLIP_SEED),
      },
      split,
      thresholds
    ),
  };
  const latencies = predictions
    .filter((x) => x.status === 'ok' && typeof x.latencyMs === 'number')
    .map((x) => x.latencyMs as number);
  const report = renderReport({
    config: {
      nodeId: node.id,
      formatId,
      specHash: spec,
      modelConfigId: model.configId,
      runKey: key,
      builds: [
        ...new Set(predictions.filter((x) => x.status === 'ok').map((x) => x.build as string)),
      ],
      hardware: (args.hardware as string) ?? null,
      targets,
      priorTestScorings,
    },
    split,
    model: scoreSplit(input, split, thresholds),
    baselines,
    fits,
    humanKappa: cohensKappa(resolved.humanPairs),
    gold: { policy: policy.kind, unresolved: resolved.ties.length },
    firstVsFinalAgreement:
      resolved.firstVsFinal.length === 0
        ? null
        : resolved.firstVsFinal.filter(([a, b]) => a === b).length / resolved.firstVsFinal.length,
    controls: {
      knownAnswer: `passed on ${control.build}`,
      plantedFlips: `${planted.size} planted on ${split}; ${flips.newErrors} became errors and ${flips.newCorrect} became correct; scorer moved by ${flips.observedDelta} as the flips imply`,
    },
    latency: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
  });
  writeFileAtomic(p.report(key, split), report);
  writeFileAtomic(
    p.thresholds(key, split),
    JSON.stringify({ runKey: key, split, fittedOn: 'dev', targets, fits }, null, 2)
  );
  console.log(`wrote ${p.report(key, split)}`);
}

async function cmdTrainManifest(args: Args, dataDir: string) {
  const node = getNode(str(args, 'node'));
  const p = paths(dataDir, node.id);
  const json = readJson<unknown>(p.evalIndex);
  if (json === undefined) throw new Error(`no eval index at ${p.evalIndex}; run build first`);
  const index = parseEvalIndex(json, node.id);
  const candidates = await readJsonl<TrainCandidate>(str(args, 'candidates'));
  const out = buildTrainManifest(candidates, index);
  writeJsonl(join(p.root, 'train-manifest.jsonl'), out);
  console.log(
    `train manifest: ${out.length} rows, 0 collisions with ${index.itemIds.length} eval items`
  );
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      node: { type: 'string' },
      format: { type: 'string' },
      model: { type: 'string' },
      split: { type: 'string' },
      target: { type: 'string' },
      'data-dir': { type: 'string' },
      candidates: { type: 'string' },
      'drop-overlap': { type: 'boolean' },
      'reseal-reason': { type: 'string' },
      'imajev-url': { type: 'string' },
      'allow-host': { type: 'string', multiple: true },
      'imajev-model-name': { type: 'string' },
      'adapter-sha256': { type: 'string' },
      rotations: { type: 'string' },
      'calibration-sha256': { type: 'string' },
      hardware: { type: 'string' },
    },
  });
  const args = values as Args;
  if (command === 'control') return cmdControl(args);
  const dataDir = assertDataDirOutsideRepo(str(args, 'data-dir'));
  if (command === 'build') return cmdBuild(args, dataDir);
  if (command === 'run') return cmdRun(args, dataDir);
  if (command === 'score') return cmdScore(args, dataDir);
  if (command === 'train-manifest') return cmdTrainManifest(args, dataDir);
  throw new Error(
    `unknown command "${command}"; expected control, build, run, score or train-manifest`
  );
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/decision-eval/cli.ts')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
