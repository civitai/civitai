import { describe, expect, it } from 'vitest';
import { audioMetadataSchema } from '~/server/schema/media.schema';

describe('audioMetadataSchema', () => {
  it('parses a song with synced and unsynced lyric lines and no dimensions', () => {
    const parsed = audioMetadataSchema.safeParse({
      duration: 183.4,
      title: 'Night Drive',
      lyrics: [
        { t: 0, text: 'First line' },
        { t: null, text: 'Unsynced line' },
      ],
      bpm: 120,
      key: 'A minor',
    });
    expect(parsed.success).toBe(true);
  });

  it('requires a duration', () => {
    expect(audioMetadataSchema.safeParse({ title: 'No length' }).success).toBe(false);
  });

  it('keeps a song that turned remixing off', () => {
    expect(audioMetadataSchema.parse({ duration: 10, allowRemix: false })).toEqual({
      duration: 10,
      allowRemix: false,
    });
  });

  it('rejects a lyric line without text', () => {
    expect(audioMetadataSchema.safeParse({ duration: 10, lyrics: [{ t: 1 }] }).success).toBe(false);
  });
});
