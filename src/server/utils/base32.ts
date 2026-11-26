// Unpadded lowercase RFC 4648 base32: the preview-session host labels
// (`preview-session-host.ts`) and the viewer-keyed document keys (`doc-store-viewer-keyed.ts`).
// 🔴 Both outputs are persisted or published identifiers: a change to this encoding changes them.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function base32Encode(raw: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of raw) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** Lowercase alphabet only (null on any other character). Spare trailing bits are discarded. */
export function base32Decode(text: string): Buffer | null {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}
