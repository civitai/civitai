import { describe, expect, it } from 'vitest';
import { preprocessFile } from '~/utils/media-preprocessors';

// A 64x48 still AVIF (libavif, 8-bit 4:2:0).
const STILL_AVIF =
  'AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAAImlsb2MAAAAAREAAAQABAAAAAAD6AAEAAAAAAAAANAAAACNpaW5mAAAAAAABAAAAFWluZmUCAAAAAAEAAGF2MDEAAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgQAMAAAAABRpc3BlAAAAAAAAAEAAAAAwAAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAA8bWRhdBIACgkYFX+9ggIaDQgyJRgACiiihQDA0Hnl0GISe05U75KBEGYZwn5pmIOxZKIpzLPMxUA=';

describe('an AVIF upload in a real browser', () => {
  it('decodes to its dimensions and a blurhash', async () => {
    const bytes = Uint8Array.from(atob(STILL_AVIF), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'still.avif', { type: 'image/avif' });

    const result = await preprocessFile(file);

    expect(result.type).toBe('image');
    expect(result.mimeType).toBe('image/avif');
    expect(result.metadata).toMatchObject({ width: 64, height: 48, size: bytes.length });
    expect((result.metadata as { hash?: string }).hash).toMatch(/^.{6,}$/);
  });
});
