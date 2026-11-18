/**
 * Every plain-string url field of an orchestrator step output, and what reaches the app.
 *
 * The pass-through walk lifts Blob-shaped values into media, which the restriction rule and
 * the host media route then judge. A url carried as a plain string is invisible to that walk,
 * so each one is named here by its output type and field:
 *   - `lift`:  the walk lifts it as a blob (the whole output is one), so it is judged.
 *   - `strip`: removed before the walk; the app never receives it.
 *   - `pass`:  forwarded as is. Not host-stored media (search results, an input echo), or a
 *     live session's own channel that the app drives and reads for the viewer alone.
 *
 * `plain-url-fields.test.ts` reads the client's output types and fails on any url field this
 * table does not name, so a new one is classified before it can reach an app.
 */
export const PLAIN_URL_FIELDS = {
  // Training epochs are stripped or lifted by `stripTrainingEpochs` (`STRIPPED_EPOCH_KEYS`).
  'EpochResult.blobUrl': { stepType: 'imageResourceTraining', treatment: 'strip' },
  'EpochResult.sampleImages': { stepType: 'imageResourceTraining', treatment: 'lift' },
  'TrainingOutputEpochResult.traceUrl': { stepType: 'training', treatment: 'strip' },
  'ImageResourceTrainingOutput.sampleInputImages': {
    stepType: 'imageResourceTraining',
    treatment: 'strip',
  },
  'BlobArchiveOutput.url': { stepType: 'blobArchive', treatment: 'strip' },
  'CustomComfyOutput.traceUrl': { stepType: 'customComfy', treatment: 'strip' },
  'TranscodeOutput.url': { stepType: 'transcode', treatment: 'lift' },
  'TranscodeOutput.publicUrl': { stepType: 'transcode', treatment: 'lift' },
  'TranscodeOutput.urlExpiresAt': { stepType: 'transcode', treatment: 'lift' },
  'LiveTextToSpeechOutput.inputUrl': { stepType: 'liveTextToSpeech', treatment: 'pass' },
  'LiveTextToSpeechOutput.inputUrlExpiresAt': { stepType: 'liveTextToSpeech', treatment: 'pass' },
  'LiveTextToSpeechOutput.audioUrl': { stepType: 'liveTextToSpeech', treatment: 'pass' },
  'LiveTextToSpeechOutput.socketUrl': { stepType: 'liveTextToSpeech', treatment: 'pass' },
  'LiveTranscriptionOutput.inputUrl': { stepType: 'liveTranscription', treatment: 'pass' },
  'LiveTranscriptionOutput.inputUrlExpiresAt': {
    stepType: 'liveTranscription',
    treatment: 'pass',
  },
  'LiveTranscriptionOutput.transcriptUrl': { stepType: 'liveTranscription', treatment: 'pass' },
  'LiveTranscriptionOutput.socketUrl': { stepType: 'liveTranscription', treatment: 'pass' },
  'WebSearchResult.url': { stepType: 'webSearch', treatment: 'pass' },
  'BatchOcrSafetyClassificationResult.mediaUrl': {
    stepType: 'batchOcrSafetyClassification',
    treatment: 'pass',
  },
} as const satisfies Record<string, { stepType: string; treatment: 'lift' | 'strip' | 'pass' }>;

/** Top-level output fields stripped before the walk, by lower-cased `$type`. */
const STRIPPED_TOP_LEVEL = new Map<string, string[]>();
for (const [key, { stepType, treatment }] of Object.entries(PLAIN_URL_FIELDS)) {
  // Nested fields (epochs, results) are owned by their own handlers.
  if (treatment !== 'strip' || key.startsWith('EpochResult.')) continue;
  if (key.startsWith('TrainingOutputEpochResult.')) continue;
  const field = key.slice(key.indexOf('.') + 1);
  const type = stepType.toLowerCase();
  STRIPPED_TOP_LEVEL.set(type, [...(STRIPPED_TOP_LEVEL.get(type) ?? []), field]);
}

/** The step output with its stripped plain-url fields removed; anything else is unchanged. */
export function stripPlainUrlFields(stepType: string, output: unknown): unknown {
  const fields = STRIPPED_TOP_LEVEL.get(stepType.toLowerCase());
  if (!fields || !output || typeof output !== 'object' || Array.isArray(output)) return output;
  const copy = { ...(output as Record<string, unknown>) };
  for (const field of fields) delete copy[field];
  return copy;
}
