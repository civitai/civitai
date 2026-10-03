import { createHash } from 'crypto';
import JSZip from 'jszip';

import { buildTrainManifest, type EvalIndex, type TrainCandidate } from './builder';
import { toImajevQuestions } from './imajev-client';
import { findPii } from './safety';
import type { DataClass, DecisionQuestion, DecisionState, FormatSpec, TrainTarget } from './types';

export const TRAINER_MANIFEST_PATH = 'data/manifests/decision.jsonl';

/** imajev commit whose `jev_api.to_request` the port below reproduces; the golden fixture is generated there. */
export const IMAJEV_TO_REQUEST_COMMIT = 'ccf586d43d2a580319b6535c893668904d909eb9';

const UNKNOWN = '__unknown__';
const MAX_QUESTIONS = 8;
// to_request's default: fits both the shipped 255-code readout and the 256-code one.
const MAX_OPTIONS = 254;
const MAX_LEVELS = 10;
const MAX_TEXT = 2000;
const MAX_OPTION_KEY = 128;
const MAX_REQUEST_ID = 128;
const MAX_STATE_BYTES = 131072;
const FIELD_ID = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// A fixed mtime keeps the zip's sha256 a function of its rows alone.
const ZIP_DATE = new Date(Date.UTC(2026, 0, 1));

export class TrainerDatasetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrainerDatasetError';
  }
}

export type ImajevField =
  | {
      id: string;
      question: string;
      type: 'choice';
      options: { value: string; description: string | null }[];
    }
  | {
      id: string;
      question: string;
      type: 'boolean';
      yes_description: null;
      no_description: null;
    }
  | {
      id: string;
      question: string;
      type: 'ordinal';
      levels: { value: number; description: string }[];
    };

/** imajev's internal `Request`, as `Request.model_dump(mode="json")` prints it. */
export type ImajevRequest = {
  schema_version: '1.0';
  request_id: string;
  state: DecisionState;
  fields: ImajevField[];
  execution: { mode: 'inspect'; allow_external_fallback: false };
};

function codePoints(value: string): number {
  return [...value].length;
}

function text(value: string, path: string): string {
  const n = codePoints(value);
  if (n < 1 || n > MAX_TEXT) {
    throw new TrainerDatasetError(`${path} must be 1-${MAX_TEXT} characters, got ${n}`);
  }
  return value;
}

/**
 * TS port of imajev `jev_api.to_request` for the questions this harness can express: string
 * instructions, no `multi`, and a noul without criteria. Pinned to imajev by a golden fixture.
 */
export function toImajevRequest(
  requestId: string,
  state: DecisionState,
  questions: readonly DecisionQuestion[]
): ImajevRequest {
  const idLength = codePoints(requestId);
  if (idLength < 1 || idLength > MAX_REQUEST_ID) {
    throw new TrainerDatasetError(`request id must be 1-${MAX_REQUEST_ID} characters`);
  }
  if (questions.length === 0 || questions.length > MAX_QUESTIONS) {
    throw new TrainerDatasetError(
      `a request has 1-${MAX_QUESTIONS} questions, got ${questions.length}`
    );
  }
  const ids = new Set<string>();
  const fields = questions.map((q): ImajevField => {
    if (!FIELD_ID.test(q.id))
      throw new TrainerDatasetError(`question id "${q.id}" is not a valid field id`);
    if (ids.has(q.id)) throw new TrainerDatasetError(`duplicate question id "${q.id}"`);
    ids.add(q.id);
    const question = text(q.instructions, `${q.id}.instructions`);
    if (q.type === 'noul') {
      return { id: q.id, question, type: 'boolean', yes_description: null, no_description: null };
    }
    if (q.type === 'choice') {
      if (q.options.length < 2 || q.options.length > MAX_OPTIONS) {
        throw new TrainerDatasetError(
          `${q.id} needs 2-${MAX_OPTIONS} options, got ${q.options.length}`
        );
      }
      const keys = new Set<string>();
      return {
        id: q.id,
        question,
        type: 'choice',
        options: q.options.map((o) => {
          const n = codePoints(o.key);
          if (n < 1 || n > MAX_OPTION_KEY || o.key === UNKNOWN) {
            throw new TrainerDatasetError(`${q.id} has an invalid option key "${o.key}"`);
          }
          if (keys.has(o.key)) throw new TrainerDatasetError(`${q.id} repeats option "${o.key}"`);
          keys.add(o.key);
          return {
            value: o.key,
            description: o.description ? text(o.description, `${q.id}.${o.key}`) : null,
          };
        }),
      };
    }
    if (q.criteria.length < 2 || q.criteria.length > MAX_LEVELS) {
      throw new TrainerDatasetError(
        `${q.id} needs 2-${MAX_LEVELS} levels, got ${q.criteria.length}`
      );
    }
    return {
      id: q.id,
      question,
      type: 'ordinal',
      levels: q.criteria.map((c, i) => ({
        value: i,
        description: text(c, `${q.id}.levels[${i}]`),
      })),
    };
  });
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > MAX_STATE_BYTES) {
    throw new TrainerDatasetError(`state exceeds ${MAX_STATE_BYTES} bytes`);
  }
  return {
    schema_version: '1.0',
    request_id: requestId,
    state,
    fields,
    execution: { mode: 'inspect', allow_external_fallback: false },
  };
}

function assertTarget(q: DecisionQuestion, target: TrainTarget, gold: string): void {
  if (target === null) return;
  const ok =
    q.type === 'choice'
      ? typeof target === 'string' && q.options.some((o) => o.key === target)
      : q.type === 'noul'
      ? typeof target === 'boolean'
      : Number.isInteger(target) &&
        (target as number) >= 0 &&
        (target as number) < q.criteria.length;
  if (!ok) {
    throw new TrainerDatasetError(
      `gold "${gold}" maps ${q.id} to ${JSON.stringify(target)}, which is not a ${
        q.type
      } answer to it`
    );
  }
}

export type TrainerRow = {
  id: string;
  group_key: string;
  partition: 'train' | 'dev';
  request: ImajevRequest;
  /** What serving sends; kept so the trainer can check the port against imajev's own conversion. */
  jev: { state: DecisionState; questions: ReturnType<typeof toImajevQuestions> };
  targets: Record<string, TrainTarget>;
  images: [];
};

export type TrainerDatasetInput = {
  nodeId: string;
  dataClass: DataClass;
  candidates: readonly TrainCandidate[];
  index: EvalIndex;
  excludedIds: readonly string[];
  gold: ReadonlyMap<string, string>;
  questions: readonly DecisionQuestion[];
  format: FormatSpec;
};

export type TrainerDatasetSummary = {
  rows: number;
  partitions: { train: number; dev: number };
  skipped: { noGold: number; untrainable: number; pii: number };
};

export function buildTrainerRows(input: TrainerDatasetInput): {
  rows: TrainerRow[];
  summary: TrainerDatasetSummary;
} {
  if (input.dataClass === 'moderation-image') {
    throw new TrainerDatasetError(
      `${input.nodeId} is moderation data; training datasets are not built from it yet`
    );
  }
  const trainTargets = input.format.trainTargets;
  if (!trainTargets) {
    throw new TrainerDatasetError(`this format of ${input.nodeId} defines no trainTargets`);
  }
  // Re-checked against today's index: it only grows, so a manifest that passed yesterday can collide now.
  const candidates = buildTrainManifest(input.candidates, input.index, input.excludedIds);

  const jevQuestions = toImajevQuestions(input.questions);
  const rows: TrainerRow[] = [];
  const skipped = { noGold: 0, untrainable: 0, pii: 0 };
  for (const c of candidates) {
    if (c.imageRefs?.length) {
      throw new TrainerDatasetError(
        `item ${c.itemId} carries images; image datasets are not supported`
      );
    }
    if (findPii(c.state)) {
      skipped.pii++;
      continue;
    }
    const gold = input.gold.get(c.itemId);
    if (gold === undefined) {
      skipped.noGold++;
      continue;
    }
    const targets = trainTargets(gold);
    if (targets === null) {
      skipped.untrainable++;
      continue;
    }
    const expected = input.questions.map((q) => q.id).sort();
    const got = Object.keys(targets).sort();
    if (JSON.stringify(expected) !== JSON.stringify(got)) {
      throw new TrainerDatasetError(
        `gold "${gold}" gives targets for [${got.join(', ')}], the format asks [${expected.join(
          ', '
        )}]`
      );
    }
    for (const q of input.questions) assertTarget(q, targets[q.id], gold);
    rows.push({
      id: c.itemId,
      group_key: c.groupKey,
      partition: c.partition === 'trainer-dev' ? 'dev' : 'train',
      request: toImajevRequest(c.itemId, c.state, input.questions),
      jev: { state: c.state, questions: jevQuestions },
      targets,
      images: [],
    });
  }
  const partitions = {
    train: rows.filter((r) => r.partition === 'train').length,
    dev: rows.filter((r) => r.partition === 'dev').length,
  };
  if (partitions.train === 0 || partitions.dev === 0) {
    throw new TrainerDatasetError(
      `the trainer needs rows in both partitions; got train ${partitions.train}, dev ${partitions.dev}`
    );
  }
  return { rows, summary: { rows: rows.length, partitions, skipped } };
}

export async function zipTrainerDataset(
  rows: readonly TrainerRow[]
): Promise<{ bytes: Buffer; sha256: string }> {
  const zip = new JSZip();
  zip.file(TRAINER_MANIFEST_PATH, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', {
    date: ZIP_DATE,
  });
  const bytes = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    platform: 'UNIX',
  });
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Not an AIR, so a payload submitted without replacing it fails validation. */
export const TRAINING_DATA_PLACEHOLDER = 'REPLACE-WITH-THE-AIR-OF-THE-UPLOADED-ZIP';

export const IMAJEV_BASE_MODEL =
  'urn:air:imajev:repository:huggingface:Qwen/Qwen3.5-4B@851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a.tar';
export const IMAJEV_BASE_ADAPTER =
  'urn:air:imajev:repository:huggingface:mohit67890/imajev-4b@f8d8234cebc6c99065c07731e59716dc0a6e27ab.tar';

/**
 * The orchestrator workflow that would train on this dataset. Never submitted from here: the step
 * is privileged, so a human uploads the zip, replaces the placeholder and submits it.
 */
export function trainingWorkflow(count: number, params: { epochs: number }) {
  return {
    steps: [
      {
        $type: 'training',
        name: 'train',
        input: {
          engine: 'imajev',
          model: IMAJEV_BASE_MODEL,
          adapter: IMAJEV_BASE_ADAPTER,
          trainingData: { type: 'zip', sourceUrl: TRAINING_DATA_PLACEHOLDER, count },
          epochs: params.epochs,
        },
      },
    ],
  };
}
