import { createHash } from 'crypto';
import { crc32, deflateSync } from 'zlib';

import { assertArmAllowed, assertNoPii, EvalSafetyError } from './safety';
import { isAnswered } from './scorer';
import type {
  DataClass,
  DecisionQuestion,
  ImageDecisionModel,
  ImageInput,
  Prediction,
  TextDecisionModel,
} from './types';

export class ControlFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlFailedError';
  }
}

/** Deterministic PRNG so planted flips and the random baseline are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A solid-colour PNG built in memory, so the image control needs no user content. */
export function solidPng(width: number, height: number, rgb: [number, number, number]): ImageInput {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array()),
  ]);
  return {
    bytes: new Uint8Array(bytes),
    contentType: 'image/png',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export type KnownAnswerControl = {
  question: Extract<DecisionQuestion, { type: 'choice' }>;
  state: Record<string, string>;
  expected: string;
};

export const TEXT_CONTROL: KnownAnswerControl = {
  state: { note: 'Invoice 4471 for 25 dollars was paid in full on the due date.' },
  question: {
    id: 'paid',
    type: 'choice',
    instructions: 'Has the invoice described in state.note been paid?',
    options: [
      { key: 'paid', description: 'the invoice has been paid' },
      { key: 'unpaid', description: 'the invoice is still outstanding' },
    ],
  },
  expected: 'paid',
};

export const IMAGE_CONTROL: KnownAnswerControl & { image: ImageInput } = {
  state: { context: 'A single test image.' },
  question: {
    id: 'colour',
    type: 'choice',
    instructions: 'What colour fills the whole image?',
    options: [
      { key: 'red', description: 'the image is solid red' },
      { key: 'green', description: 'the image is solid green' },
      { key: 'blue', description: 'the image is solid blue' },
    ],
  },
  expected: 'red',
  image: solidPng(64, 64, [220, 20, 20]),
};

/**
 * One real call with a known answer before a run is trusted. A mocked suite
 * stayed green while the first Jev client returned 400 on every live call.
 * A node may supply its own control, so it passes the same gates as its items.
 */
export async function runKnownAnswerControl(
  model: TextDecisionModel | ImageDecisionModel,
  control: KnownAnswerControl & { image?: ImageInput },
  dataClass: DataClass
): Promise<{ answer: string; build: string }> {
  assertArmAllowed(dataClass, model);
  assertNoPii('known-answer control', control.state);
  if (control.image && !('decideWithImages' in model)) {
    throw new EvalSafetyError(`${model.configId} cannot take the image control`);
  }
  const request = { state: control.state, questions: [control.question] };
  const result = control.image
    ? await (model as ImageDecisionModel).decideWithImages({
        ...request,
        images: [control.image],
      })
    : await model.decide(request);
  const answer = result.answers[0];
  if (!answer || answer.value !== control.expected) {
    throw new ControlFailedError(
      `known-answer control on ${model.configId}: expected "${control.expected}", got "${String(
        answer?.value
      )}"`
    );
  }
  return { answer: String(answer.value), build: result.build };
}

/**
 * Flip `count` gold labels to a different class. The flipped set is scored as
 * its own control and never contaminates the reported metrics.
 */
export function plantFlippedLabels(
  gold: ReadonlyMap<string, string>,
  classes: readonly string[],
  count: number,
  seed: number
): { gold: Map<string, string>; planted: Map<string, { original: string; flipped: string }> } {
  if (classes.length < 2) throw new ControlFailedError('flipping labels needs at least 2 classes');
  const rand = mulberry32(seed);
  const ids = [...gold.keys()].sort();
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const flippedGold = new Map(gold);
  const planted = new Map<string, { original: string; flipped: string }>();
  for (const id of ids.slice(0, count)) {
    const original = gold.get(id) as string;
    const others = classes.filter((c) => c !== original);
    const flipped = others[Math.floor(rand() * others.length)];
    flippedGold.set(id, flipped);
    planted.set(id, { original, flipped });
  }
  return { gold: flippedGold, planted };
}

export type CorrectCounter = (gold: ReadonlyMap<string, string>) => number;

/**
 * The scorer must move by exactly what the flips imply: every planted item the
 * model matched under the true label becomes an error, and every one it matched
 * under the flipped label becomes correct. A scorer that ignores gold, or reads
 * it from the wrong place, moves by something else.
 */
export function verifyPlantedFlips(
  predictions: readonly Prediction[],
  trueGold: ReadonlyMap<string, string>,
  planted: ReadonlyMap<string, { original: string; flipped: string }>,
  countCorrect: CorrectCounter
): { expectedDelta: number; observedDelta: number; newErrors: number; newCorrect: number } {
  const byId = new Map(predictions.map((p) => [p.itemId, p]));
  let newErrors = 0;
  let newCorrect = 0;
  for (const [id, { original, flipped }] of planted) {
    const p = byId.get(id);
    if (!p || !isAnswered(p)) continue;
    if (p.pred === original) newErrors++;
    if (p.pred === flipped) newCorrect++;
  }
  const flippedGold = new Map(trueGold);
  for (const [id, { flipped }] of planted) flippedGold.set(id, flipped);
  const expectedDelta = newCorrect - newErrors;
  const observedDelta = countCorrect(flippedGold) - countCorrect(trueGold);
  if (observedDelta !== expectedDelta) {
    throw new ControlFailedError(
      `planted-flip control: scorer moved by ${observedDelta}, the flips imply ${expectedDelta}`
    );
  }
  if (planted.size > 0 && newErrors === 0) {
    throw new ControlFailedError(
      'planted-flip control: no planted item was answered with its true label, so the control proved nothing'
    );
  }
  return { expectedDelta, observedDelta, newErrors, newCorrect };
}

export function majorityBaseline(
  itemIds: readonly string[],
  trainGold: ReadonlyMap<string, string>,
  runKey = 'baseline:majority'
): Prediction[] {
  const counts = new Map<string, number>();
  for (const label of trainGold.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (!top) throw new ControlFailedError('majority baseline needs labelled items');
  return itemIds.map((itemId) => ({
    itemId,
    runKey,
    status: 'ok',
    pred: top[0],
    confidence: 1,
    abstained: false,
  }));
}

export function randomBaseline(
  itemIds: readonly string[],
  classes: readonly string[],
  seed: number,
  runKey = 'baseline:random'
): Prediction[] {
  const rand = mulberry32(seed);
  return itemIds.map((itemId) => ({
    itemId,
    runKey,
    status: 'ok',
    pred: classes[Math.floor(rand() * classes.length)],
    confidence: rand(),
    abstained: false,
  }));
}
