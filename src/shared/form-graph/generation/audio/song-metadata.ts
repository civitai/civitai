import { SONG_KEY_MAX_LENGTH } from '~/server/common/constants';
import type { AudioMetadata, LyricLine } from '~/server/schema/media.schema';

/** The refusal when a user without the music flag tries to store a song. */
export const SONGS_UNAVAILABLE_MESSAGE = 'Songs are not available yet.';

export type SongDetails = Partial<Pick<AudioMetadata, 'title' | 'lyrics' | 'bpm' | 'key'>>;

/** What a simple-mode song's drafting chat step decided; the form never holds these. */
export type SongConcept = { lyrics?: unknown; bpm?: unknown; key?: unknown };

export function parseLyricLines(lyrics: unknown): LyricLine[] | undefined {
  if (typeof lyrics !== 'string') return undefined;
  const lines = lyrics
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({ t: null, text }));
  return lines.length ? lines : undefined;
}

const nonEmptyString = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const songKey = (value: unknown) => {
  const key = nonEmptyString(value);
  return key && key.length <= SONG_KEY_MAX_LENGTH ? key : undefined;
};
const positiveNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * The song details a generated output carries into a post. Form params win; the drafted concept
 * fills what a simple-mode form never holds. Values of the wrong shape are dropped.
 */
export function buildSongDetails(
  params: Record<string, unknown> | null | undefined,
  concept?: SongConcept | null
): SongDetails {
  const details: SongDetails = {
    title: nonEmptyString(params?.title),
    lyrics: parseLyricLines(params?.lyrics) ?? parseLyricLines(concept?.lyrics),
    bpm: positiveNumber(params?.bpm) ?? positiveNumber(concept?.bpm),
    key: songKey(params?.key) ?? songKey(concept?.key),
  };
  return Object.fromEntries(Object.entries(details).filter(([, v]) => v !== undefined));
}

/** Whether a song's owner lets others remix it; only an explicit `allowRemix: false` refuses. */
export function songAllowsRemix(metadata: unknown): boolean {
  return (metadata as { allowRemix?: unknown } | null | undefined)?.allowRemix !== false;
}

/** The drafting step's parsed output, from raw orchestrator workflow steps. */
export function readSongConcept(
  steps: readonly { $type?: string; output?: unknown }[] | null | undefined
): SongConcept | undefined {
  const step = steps?.find((s) => s.$type === 'chatCompletion');
  const parsed = (step?.output as { parsed?: unknown } | null | undefined)?.parsed;
  if (!parsed || typeof parsed !== 'object') return undefined;
  const { lyrics, bpm, key } = parsed as SongConcept;
  return { lyrics, bpm, key };
}

/** Orchestrator step types that sing lyrics. */
export const SONG_STEP_TYPES: readonly string[] = ['aceStepAudio', 'miniMaxMusic3', 'yuE2'];

/**
 * The lyrics a generation workflow was asked to sing: the audio step's own input (custom mode, and
 * the resolved text in simple mode), else the drafting step's output. Read from the workflow, never
 * taken from the client.
 */
export function readWorkflowLyrics(
  steps: readonly { $type?: string; input?: unknown; output?: unknown }[] | null | undefined
): string | undefined {
  const fromAudioStep = steps
    ?.filter((s) => s.$type && SONG_STEP_TYPES.includes(s.$type))
    .map((s) => (s.input as { lyrics?: unknown } | null | undefined)?.lyrics)
    .find((lyrics): lyrics is string => typeof lyrics === 'string' && !!lyrics.trim());
  if (fromAudioStep) return fromAudioStep;
  const drafted = readSongConcept(steps)?.lyrics;
  return typeof drafted === 'string' ? drafted : undefined;
}
