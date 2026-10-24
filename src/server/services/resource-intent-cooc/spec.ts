import { createHash } from 'crypto';

import { ROLE_MODEL_TYPES } from '~/server/schema/resource-intent.schema';
import { COOC_PAYLOAD_FORMAT, CoocCountAccumulator } from './build';
import { loadScores, rankCooc } from './score';
import { coocQueryTokens, coocTrainingTokens } from './tokenize';

/**
 * The co-occurrence index as the offline screen chose it on its validation slice, before its test
 * rows were scored. Change a value only with a new screen.
 */
export const RESOURCE_INTENT_COOC_SPEC = {
  trainDays: 120,
  gapDays: 1,
  targetRows: 200_000,
  idBatch: 20_000,
  maxBatches: 200,
  defaultSeed: 20261008,
  minSup: 2,
  dfMax: 0.05,
  beta: 10,
  topK: 300,
  /** The union of the per-role types: only these attachments are indexed. */
  addonTypes: [...new Set(Object.values(ROLE_MODEL_TYPES).flatMap((t) => t ?? []))].sort(),
} as const;

/**
 * Hashes what the tokeniser, the counts and the ranking produce on a fixed fixture, plus the
 * constants. A behaviour change the fixture does not exercise does not move it.
 */
function coocFingerprint() {
  const spec = RESOURCE_INTENT_COOC_SPEC;
  const prompts = [
    '(masterpiece:1.2), <lora:Foo_Bar:0.8> Gizmo city, BREAK embedding:EasyNeg neon armor',
    'neon city armor, the 12345 ab rain',
    'café rain neon, gizmo armor, (rain:0.7)',
    'city armor rain',
  ];
  const own = [{ modelName: 'Gizmo Wonder Style v2 LoRA', trainedWords: ['gzmwndr pose, shiny'] }];
  const acc = new CoocCountAccumulator(spec.addonTypes);
  const models: [number, string][][] = [
    [
      [7, 'LORA'],
      [9, 'Checkpoint'],
    ],
    [
      [7, 'LORA'],
      [3, 'TextualInversion'],
    ],
    [[3, 'TextualInversion']],
    [
      [7, 'LORA'],
      [3, 'TextualInversion'],
    ],
  ];
  prompts.forEach((p, i) => acc.add(coocTrainingTokens(p, i === 0 ? own : []), models[i]));
  // Low minSup / high dfMax so the four-row fixture keeps pairs; the real values are hashed below.
  const counts = acc.finalize({ addonTypes: spec.addonTypes, minSup: 1, dfMax: 1, beta: 0.5 });
  const scores = loadScores(counts, { beta: 0.5 });
  return {
    spec,
    payloadFormat: COOC_PAYLOAD_FORMAT,
    tokens: prompts.map((p) => coocQueryTokens(p)),
    training: coocTrainingTokens(prompts[0], own),
    counts: {
      ...counts,
      nT: [...counts.nT],
      nM: [...counts.nM],
      ptr: [...counts.ptr],
      modelIdx: [...counts.modelIdx],
      c: [...counts.c],
    },
    ranked: rankCooc(
      scores,
      coocQueryTokens('neon rain city café'),
      ['LORA', 'TextualInversion'],
      2
    ),
    rankedNoTypes: rankCooc(scores, ['neon'], null, 5),
  };
}

export const RESOURCE_INTENT_COOC_SPEC_HASH = createHash('sha256')
  .update(JSON.stringify(coocFingerprint()))
  .digest('hex');
