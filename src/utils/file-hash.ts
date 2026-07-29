import jsSHA from 'jssha';

export const OFFICIAL_MATCH_HASH_MAX_BYTES = 5 * 1024 ** 3; // 5 GB — above this, defer to the server-side post-scan dedup
const WEBCRYPTO_MAX_BYTES = 1024 ** 3; // ≤1 GB: native one-shot; larger: streamed jsSHA
const STREAM_CHUNK = 100 * 1024 * 1024; // 100 MB

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// Native WebCrypto SHA-256 over the whole file — fastest, but buffers the
// entire file in memory. Used for ≤1 GB. Available in workers + node 20+.
export async function sha256WebCrypto(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return toHex(new Uint8Array(digest));
}

// Streaming SHA-256 via jsSHA — flat memory, handles arbitrarily large files.
// Used above the WebCrypto threshold. (NOT the broken hash-chaining variant —
// this feeds every chunk into one running digest via jsSHA.update.)
export async function sha256Streaming(blob: Blob, chunkSize: number = STREAM_CHUNK): Promise<string> {
  const sha = new jsSHA('SHA-256', 'ARRAYBUFFER');
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const chunk = blob.slice(offset, offset + chunkSize);
    sha.update(await chunk.arrayBuffer());
  }
  return sha.getHash('HEX');
}

// Full-file SHA256 (lowercase hex) = byte identity, matching the stored
// ModelFileHash.SHA256.
export async function computeBlobSha256(blob: Blob): Promise<string> {
  return blob.size <= WEBCRYPTO_MAX_BYTES ? sha256WebCrypto(blob) : sha256Streaming(blob);
}
