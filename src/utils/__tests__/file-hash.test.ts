import { describe, it, expect } from 'vitest';
import { computeBlobSha256, sha256WebCrypto, sha256Streaming } from '~/utils/file-hash';

const KNOWN_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('file-hash', () => {
  it('computeBlobSha256 matches the known SHA256 of "abc" (lowercase hex)', async () => {
    const blob = new Blob([new TextEncoder().encode('abc')]);
    expect(await computeBlobSha256(blob)).toBe(KNOWN_ABC);
  });

  it('native and streaming strategies both match the known vector', async () => {
    const blob = new Blob([new TextEncoder().encode('abc')]);
    expect(await sha256WebCrypto(blob)).toBe(KNOWN_ABC);
    expect(await sha256Streaming(blob, 1)).toBe(KNOWN_ABC); // 1-byte chunks exercise the update loop
  });

  it('streaming matches native on a larger buffer', async () => {
    const bytes = new Uint8Array(50_000).map((_, i) => i % 256);
    const blob = new Blob([bytes]);
    expect(await sha256Streaming(blob, 1024)).toBe(await sha256WebCrypto(blob));
  });
});
