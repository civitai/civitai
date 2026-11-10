import type { AudioMetadata } from '~/server/schema/media.schema';

/** The refusal when a user without the music flag tries to store a song. */
export const SONGS_UNAVAILABLE_MESSAGE = 'Songs are not available yet.';

export type SongDetails = Partial<Pick<AudioMetadata, 'title' | 'lyrics' | 'bpm' | 'key'>>;

/** What a simple-mode song's drafting chat step decided; the form never holds these. */
export type SongConcept = { lyrics?: unknown; bpm?: unknown; key?: unknown };

export function parseLyricLines(lyrics: unknown): AudioMetadata['lyrics'] {
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
    key: nonEmptyString(params?.key) ?? nonEmptyString(concept?.key),
  };
  return Object.fromEntries(Object.entries(details).filter(([, v]) => v !== undefined));
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
